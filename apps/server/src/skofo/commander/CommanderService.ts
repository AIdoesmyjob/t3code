import {
  CommandId,
  type EnvironmentId,
  isListedThreadLineage,
  MessageId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
  ThreadTag,
} from "@t3tools/contracts";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as CommanderStore from "./CommanderStore.ts";
import {
  isSkofoCommanderEnabled,
  SKOFO_COMMANDER_DEFAULT_INSTANCE_ID,
  SKOFO_COMMANDER_DEFAULT_MODEL,
  SKOFO_COMMANDER_PROJECT_TITLE,
  SKOFO_COMMANDER_TAG,
  SKOFO_COMMANDER_TITLE,
  SKOFO_COMMANDER_WORKSPACE_SUBDIR,
} from "./constants.ts";

export interface CommanderAttentionCounts {
  readonly active: number;
  readonly working: number;
  readonly blocked: number;
  readonly failed: number;
}

export interface CommanderSummary {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly status: string | null;
  readonly watchCount: number;
  readonly pendingFreshContext: boolean;
  readonly lastRolloverAt: string | null;
  readonly counts: CommanderAttentionCounts;
}

export interface CommanderRolloverState {
  readonly threadId: ThreadId | null;
  readonly pendingFreshContext: boolean;
  readonly rolloverRunBaseline: number;
  readonly lastRolloverAt: string | null;
}

export interface CommanderServiceShape {
  readonly enabled: boolean;
  readonly workspaceDir: string;
  readonly ensureProvisioned: Effect.Effect<{
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  } | null>;
  readonly getCommanderThreadId: Effect.Effect<ThreadId | null>;
  readonly isCommanderThread: (threadId: ThreadId | undefined) => Effect.Effect<boolean>;
  readonly getSummary: Effect.Effect<CommanderSummary>;
  readonly getRolloverState: Effect.Effect<CommanderRolloverState>;
  readonly listWatches: Effect.Effect<ReadonlyArray<CommanderStore.CommanderWatch>>;
  readonly watchThread: (input: {
    readonly environmentId?: EnvironmentId | undefined;
    readonly threadId: ThreadId;
    readonly title?: string | undefined;
    readonly until?: CommanderStore.CommanderWatchUntil | undefined;
    readonly note?: string | undefined;
  }) => Effect.Effect<CommanderStore.CommanderWatch>;
  readonly unwatchThread: (input: {
    readonly environmentId?: EnvironmentId | undefined;
    readonly threadId: ThreadId;
  }) => Effect.Effect<{ readonly removed: boolean }>;
  readonly updateWatchSnapshot: (input: {
    readonly environmentId?: EnvironmentId | undefined;
    readonly threadId: ThreadId;
    readonly status?: string | undefined;
    readonly runId?: string | null | undefined;
  }) => Effect.Effect<void>;
  readonly dispatchWake: (input: {
    readonly text: string;
    readonly urgent?: boolean | undefined;
    readonly freshContext?: boolean | undefined;
    readonly bypassRateLimit?: boolean | undefined;
  }) => Effect.Effect<{ readonly dispatched: boolean; readonly reason?: string }>;
  readonly consumePendingFreshContext: Effect.Effect<boolean>;
  readonly markPendingFreshContext: (input: {
    readonly pending: boolean;
    readonly rolloverRunBaseline?: number | undefined;
    readonly lastRolloverAt?: string | undefined;
  }) => Effect.Effect<void>;
}

export class CommanderService extends Context.Service<CommanderService, CommanderServiceShape>()(
  "t3/skofo/commander/CommanderService",
) {}

const STARTER_STATE_MD = `# Computer Active State

## Current Priorities
- (none recorded yet)

## Watched Threads
- (none)

## Standing Instructions
- Conservative mode: act on Lukas's explicit instructions; alert on failures, unanswered approvals/questions (>2 min), and watched thread completions.
- Never reference or query emails unless Lukas explicitly asks.
`;

const STARTER_AGENTS_MD = `# Computer: Persistent T3 Operations Agent

You are **Computer**, Lukas's persistent top-level operations agent on \`t3code-dev\`.
Read \`STATE.md\` and \`FLEET-SNAPSHOT.md\` in your workspace and use \`skofo_work_board\`, \`skofo_watch_thread\`, \`skofo_fleet_query\`, and \`skofo_memory_search\` alongside T3's \`t3_*\` tools.
Operate conservatively: act on explicit instructions, watch assigned threads, and never access emails unless explicitly asked.
`;

export function summarizeShellAttention(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  commanderThreadId: ThreadId | null,
): CommanderAttentionCounts {
  let active = 0;
  let working = 0;
  let blocked = 0;
  let failed = 0;
  for (const thread of threads) {
    if (
      thread.id === commanderThreadId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      !isListedThreadLineage(thread.lineage)
    ) {
      continue;
    }
    active += 1;
    if (thread.pendingRuntimeRequest !== null) {
      blocked += 1;
    }
    if (thread.status === "failed") {
      failed += 1;
    } else if (
      thread.status === "running" ||
      thread.status === "starting" ||
      thread.status === "preparing" ||
      thread.status === "queued" ||
      thread.status === "waiting"
    ) {
      working += 1;
    }
  }
  return { active, working, blocked, failed };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* CommanderStore.CommanderStore;

  const enabled = isSkofoCommanderEnabled();
  const workspaceDir = path.join(config.baseDir, SKOFO_COMMANDER_WORKSPACE_SUBDIR);
  const provisionLock = yield* Semaphore.make(1);
  const envDescriptor = yield* environment.getDescriptor;

  const newCommandId = () => random.uuidV4().pipe(Effect.map(CommandId.make));

  const ensureWorkspaceFiles = Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(workspaceDir, "DAILY"), { recursive: true });
    const statePath = path.join(workspaceDir, "STATE.md");
    if (!(yield* fs.exists(statePath))) {
      yield* fs.writeFileString(statePath, STARTER_STATE_MD);
    }
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    if (!(yield* fs.exists(agentsPath))) {
      yield* fs.writeFileString(agentsPath, STARTER_AGENTS_MD);
    }
  }).pipe(Effect.ignore);

  const ensureThreadDecorations = Effect.fn("CommanderService.ensureThreadDecorations")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) return;
    if (!shell.tags?.includes(SKOFO_COMMANDER_TAG)) {
      yield* threads
        .dispatch({
          type: "thread.tag.set",
          commandId: yield* newCommandId(),
          threadId,
          tag: ThreadTag.make(SKOFO_COMMANDER_TAG),
          tagged: true,
        })
        .pipe(Effect.ignore);
    }
    if (shell.autoSettleDisabledAt == null) {
      yield* threads
        .dispatch({
          type: "thread.auto-settle.set",
          commandId: yield* newCommandId(),
          threadId,
          enabled: false,
        })
        .pipe(Effect.ignore);
    }
    if (shell.pinnedAt == null) {
      const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => []));
      const pinnedKeys = index.flatMap((entry) =>
        entry.pinnedAt == null ? [] : [entry.pinOrderKey],
      );
      const orderKey = topOfPinnedRunOrderKey(pinnedKeys) ?? undefined;
      yield* threads
        .dispatch({
          type: "thread.pin",
          commandId: yield* newCommandId(),
          threadId,
          ...(orderKey === undefined ? {} : { orderKey }),
        })
        .pipe(Effect.ignore);
    }
    if (shell.settledOverride === "settled") {
      yield* threads
        .dispatch({
          type: "thread.unsettle",
          commandId: yield* newCommandId(),
          threadId,
          reason: "user",
        })
        .pipe(Effect.ignore);
    }
  });

  const ensureProvisioned = provisionLock.withPermits(1)(
    Effect.gen(function* () {
      if (!enabled) return null;
      yield* ensureWorkspaceFiles;

      const persisted = yield* store.get;

      // 1. Check if stored thread still exists and is active.
      if (persisted.threadId !== null && persisted.projectId !== null) {
        const existing = yield* threads
          .getThreadShell(persisted.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (existing !== null && existing.deletedAt === null && existing.archivedAt === null) {
          yield* ensureThreadDecorations(existing.id);
          return { projectId: existing.projectId, threadId: existing.id };
        }
      }

      // 2. Check if any active thread already carries the skofo:commander tag.
      const snapshot = yield* projections
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.orElseSucceed(() => null));
      const tagged = snapshot?.threads.find(
        (t) =>
          t.deletedAt === null &&
          t.archivedAt === null &&
          t.tags?.includes(SKOFO_COMMANDER_TAG) === true,
      );
      if (tagged !== undefined) {
        yield* ensureThreadDecorations(tagged.id);
        yield* store.update((curr) => ({
          ...curr,
          projectId: tagged.projectId,
          threadId: tagged.id,
        }));
        return { projectId: tagged.projectId, threadId: tagged.id };
      }

      // 3. Ensure dedicated Computer workspace project exists.
      const existingProject = yield* projects
        .getByWorkspaceRoot(workspaceDir)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const projectId = Option.isSome(existingProject)
        ? existingProject.value.id
        : (yield* projects.bootstrap({
            commandId: yield* newCommandId(),
            projectId: ProjectId.make(yield* random.uuidV4()),
            title: SKOFO_COMMANDER_PROJECT_TITLE,
            workspaceRoot: workspaceDir,
          })).project.id;

      // 4. Launch the singleton Computer thread with Gemini 4 Neon (Antigravity).
      const launched = yield* threadLaunch.launch({
        commandId: yield* newCommandId(),
        projectId,
        title: SKOFO_COMMANDER_TITLE,
        modelSelection: {
          instanceId: SKOFO_COMMANDER_DEFAULT_INSTANCE_ID,
          model: SKOFO_COMMANDER_DEFAULT_MODEL,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      });

      yield* ensureThreadDecorations(launched.threadId);
      yield* store.update((curr) => ({
        ...curr,
        projectId,
        threadId: launched.threadId,
      }));
      yield* Effect.logInfo("Provisioned persistent Skofo Computer thread", {
        projectId,
        threadId: launched.threadId,
        workspaceDir,
      });
      return { projectId, threadId: launched.threadId };
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to provision Skofo Computer thread", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    ),
  );

  const getCommanderThreadId = store.get.pipe(Effect.map((s) => (enabled ? s.threadId : null)));

  const isCommanderThread = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(false)
      : getCommanderThreadId.pipe(Effect.map((id) => id !== null && id === threadId));

  const getSummary = Effect.gen(function* () {
    const state = yield* store.get;
    const threadId = enabled ? state.threadId : null;
    const snapshot = yield* projections
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.orElseSucceed(() => null));
    const shells = snapshot?.threads ?? [];
    const commanderShell =
      threadId === null ? undefined : shells.find((thread) => thread.id === threadId);
    return {
      enabled,
      environmentId: envDescriptor.environmentId,
      projectId: enabled ? state.projectId : null,
      threadId,
      title: commanderShell?.title ?? SKOFO_COMMANDER_TITLE,
      status: commanderShell?.status ?? null,
      watchCount: state.watches.length,
      pendingFreshContext: state.pendingFreshContext,
      lastRolloverAt: state.lastRolloverAt,
      counts: summarizeShellAttention(shells, threadId),
    } satisfies CommanderSummary;
  });

  const getRolloverState = store.get.pipe(
    Effect.map((state): CommanderRolloverState => ({
      threadId: enabled ? state.threadId : null,
      pendingFreshContext: state.pendingFreshContext,
      rolloverRunBaseline: state.rolloverRunBaseline,
      lastRolloverAt: state.lastRolloverAt,
    })),
  );

  const listWatches = store.get.pipe(Effect.map((state) => state.watches));

  const watchThread: CommanderServiceShape["watchThread"] = Effect.fn(
    "CommanderService.watchThread",
  )(function* (input) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const entry: CommanderStore.CommanderWatch = {
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      threadId: input.threadId,
      ...(input.title === undefined ? {} : { title: input.title }),
      until: input.until ?? "turn_end",
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: nowIso,
    };
    yield* store.update((curr) => ({
      ...curr,
      watches: CommanderStore.upsertWatch(curr.watches, entry),
    }));
    return entry;
  });

  const unwatchThread: CommanderServiceShape["unwatchThread"] = Effect.fn(
    "CommanderService.unwatchThread",
  )(function* (input) {
    let removed = false;
    yield* store.update((curr) => {
      const result = CommanderStore.removeWatch(curr.watches, input);
      removed = result.removed;
      return { ...curr, watches: result.watches };
    });
    return { removed };
  });

  const updateWatchSnapshot: CommanderServiceShape["updateWatchSnapshot"] = Effect.fn(
    "CommanderService.updateWatchSnapshot",
  )(function* (input) {
    const targetKey = CommanderStore.watchKey(input);
    yield* store.update((curr) => ({
      ...curr,
      watches: curr.watches.map((w) =>
        CommanderStore.watchKey(w) === targetKey
          ? {
              ...w,
              ...(input.status === undefined ? {} : { lastSeenStatus: input.status }),
              ...(input.runId === undefined ? {} : { lastSeenRunId: input.runId }),
            }
          : w,
      ),
    }));
  });

  const dispatchWake: CommanderServiceShape["dispatchWake"] = Effect.fn(
    "CommanderService.dispatchWake",
  )(function* (input) {
    if (!enabled) return { dispatched: false, reason: "disabled" };
    const state = yield* store.get;
    const threadId = state.threadId;
    const projectId = state.projectId;
    if (threadId === null || projectId === null) {
      return { dispatched: false, reason: "not_provisioned" };
    }
    const nowMs = yield* Clock.currentTimeMillis;

    if (!input.bypassRateLimit) {
      const decision = CommanderStore.canAutoWake({
        wakeTimestampsMs: state.wakeTimestampsMs,
        nowMs,
        urgent: input.urgent === true,
      });
      if (!decision.allowed) {
        return { dispatched: false, ...(decision.reason ? { reason: decision.reason } : {}) };
      }
    }

    const useFreshContext = input.freshContext === true || state.pendingFreshContext;
    const commandId = yield* newCommandId();
    const messageId = MessageId.make(yield* random.uuidV4());

    const sent = yield* threads
      .sendToThread({
        projectId,
        commandId,
        threadId,
        messageId,
        text: input.text,
        attachments: [],
        mode: "auto",
        ...(useFreshContext ? { freshContext: true } : {}),
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("CommanderService.dispatchWake failed", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (!sent) return { dispatched: false, reason: "dispatch_failed" };

    yield* store.update((curr) => ({
      ...curr,
      pendingFreshContext: useFreshContext ? false : curr.pendingFreshContext,
      wakeTimestampsMs: [
        ...CommanderStore.pruneWakeTimestamps(curr.wakeTimestampsMs, nowMs),
        nowMs,
      ],
    }));

    return { dispatched: true };
  });

  const consumePendingFreshContext = Effect.gen(function* () {
    let consumed = false;
    yield* store.update((curr) => {
      if (!curr.pendingFreshContext) return curr;
      consumed = true;
      return { ...curr, pendingFreshContext: false };
    });
    return consumed;
  });

  const markPendingFreshContext: CommanderServiceShape["markPendingFreshContext"] = (input) =>
    store
      .update((curr) => ({
        ...curr,
        pendingFreshContext: input.pending,
        ...(input.rolloverRunBaseline === undefined
          ? {}
          : { rolloverRunBaseline: input.rolloverRunBaseline }),
        ...(input.lastRolloverAt === undefined ? {} : { lastRolloverAt: input.lastRolloverAt }),
      }))
      .pipe(Effect.asVoid);

  return CommanderService.of({
    enabled,
    workspaceDir,
    ensureProvisioned,
    getCommanderThreadId,
    isCommanderThread,
    getSummary,
    getRolloverState,
    listWatches,
    watchThread,
    unwatchThread,
    updateWatchSnapshot,
    dispatchWake,
    consumePendingFreshContext,
    markPendingFreshContext,
  });
});

export const layer = Layer.effect(CommanderService, make).pipe(Layer.provide(CommanderStore.layer));
