// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  OrchestratorMcpThreadListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import { forkParked } from "../../serverActivation.ts";
import * as CommanderService from "./CommanderService.ts";
import { shouldTriggerContextRollover } from "./CommanderStore.ts";
import {
  SKOFO_COMMANDER_PEER_POLL_INTERVAL_MS,
  SKOFO_COMMANDER_PENDING_REQUEST_GRACE_MS,
  SKOFO_COMMANDER_ROLLOVER_CHECK_INTERVAL_MS,
  SKOFO_COMMANDER_WAKE_DEBOUNCE_MS,
} from "./constants.ts";

export interface CommanderEventNotice {
  readonly key: string;
  readonly environmentLabel: string;
  readonly environmentId?: EnvironmentId | undefined;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly summary: string;
  readonly urgent: boolean;
}

export function formatCommanderEventBatch(notices: ReadonlyArray<CommanderEventNotice>): string {
  const lines = ["[commander-event] Thread updates requiring your attention or follow-up:", ""];
  for (const notice of notices) {
    const envPart =
      notice.environmentId !== undefined
        ? ` [${notice.environmentLabel} (${notice.environmentId})]`
        : " [local]";
    lines.push(`- **${notice.title}** (\`${notice.threadId}\`${envPart}): ${notice.summary}`);
  }
  lines.push(
    "",
    "Read the relevant thread(s) with `t3_thread_read`, verify the actual outcome, update `STATE.md`, and post a concise follow-up for Lukas using each thread's verbatim `link`.",
  );
  return lines.join("\n");
}

function sendMatrixAlertBestEffort(summary: string, key: string): Effect.Effect<void> {
  if (process.env.T3CODE_SKOFO_COMMANDER_MATRIX_ALERTS === "0") {
    return Effect.void;
  }
  const coreHost = process.env.SKOFO_CORE_SSH_HOST || "10.2.2.199";
  const safeSummary = summary.replace(/[\r\n]+/g, " ").slice(0, 220);
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  const remoteCmd = `python3 ~/.openclaw/deploy/startrek-computer-main-current/scripts/matrix-alert.py --key ${JSON.stringify(safeKey)} --state info --site t3code-dev --summary ${JSON.stringify(safeSummary)}`;
  return Effect.callback<void>((resume) => {
    NodeChildProcess.execFile(
      "ssh",
      ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", coreHost, remoteCmd],
      { timeout: 10_000 },
      () => resume(Effect.void),
    );
  });
}

export class CommanderWatchReactor extends Context.Service<
  CommanderWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/skofo/commander/CommanderWatchReactor") {}

const make = Effect.gen(function* () {
  const commander = yield* CommanderService.CommanderService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const peerClient = yield* PeerMcpClient.PeerMcpClient;

  const heldNotices = yield* Ref.make<Map<string, CommanderEventNotice>>(new Map());
  const flushTimers = yield* FiberMap.make<string>();
  const pendingRequestTimers = yield* FiberMap.make<string>();

  const flushHeldNotices = Effect.fn("CommanderWatchReactor.flushHeldNotices")(function* () {
    const batch = yield* Ref.modify(heldNotices, (current) => [
      [...current.values()],
      new Map<string, CommanderEventNotice>(),
    ]);
    if (batch.length === 0) return;
    const urgent = batch.some((item) => item.urgent);
    const text = formatCommanderEventBatch(batch);
    const result = yield* commander.dispatchWake({ text, urgent });
    if (result.dispatched && urgent) {
      const headline = batch
        .filter((item) => item.urgent)
        .map((item) => `${item.title}: ${item.summary}`)
        .join("; ");
      yield* sendMatrixAlertBestEffort(
        `Computer follow-up needed: ${headline}`,
        `t3-computer-${batch[0]!.threadId}`,
      );
    }
  });

  const enqueueNotice = Effect.fn("CommanderWatchReactor.enqueueNotice")(function* (
    notice: CommanderEventNotice,
  ) {
    yield* Ref.update(heldNotices, (current) => {
      const next = new Map(current);
      next.set(notice.key, notice);
      return next;
    });
    yield* FiberMap.run(
      flushTimers,
      "debounced-flush",
      Effect.sleep(Duration.millis(SKOFO_COMMANDER_WAKE_DEBOUNCE_MS)).pipe(
        Effect.andThen(flushHeldNotices()),
      ),
    );
  });

  const handleDomainEvent = Effect.fn("CommanderWatchReactor.handleDomainEvent")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    const commanderThreadId = yield* commander.getCommanderThreadId;
    if (commanderThreadId === null || event.threadId === commanderThreadId) return;

    const watches = yield* commander.listWatches;
    const watch = watches.find(
      (w) => w.environmentId === undefined && w.threadId === event.threadId,
    );

    if (event.type === "runtime-request.updated") {
      const reqId = event.payload.id;
      const timerKey = `${event.threadId}:${reqId}`;
      if (event.payload.status === "pending") {
        const reqKind = event.payload.kind;
        yield* FiberMap.run(
          pendingRequestTimers,
          timerKey,
          Effect.sleep(Duration.millis(SKOFO_COMMANDER_PENDING_REQUEST_GRACE_MS)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const records = yield* projections
                  .getThreadRecords(event.threadId, ["runtimeRequests"])
                  .pipe(Effect.orElseSucceed(() => null));
                if (records === null) return;
                const stillPending = records.runtimeRequests.some(
                  (r) => r.id === reqId && r.status === "pending",
                );
                if (!stillPending) return;
                const kindLabel =
                  reqKind === "user_input" ? "user question" : "permission approval";
                yield* enqueueNotice({
                  key: `pending:${timerKey}`,
                  environmentLabel: "local",
                  threadId: event.threadId,
                  title: records.thread.title,
                  summary: `waiting on ${kindLabel} for over 2 minutes`,
                  urgent: true,
                });
              }),
            ),
          ),
        );
      } else {
        yield* FiberMap.remove(pendingRequestTimers, timerKey);
      }
      return;
    }

    if (event.type === "run.updated") {
      const status = event.payload.status;
      if (status !== "completed" && status !== "failed") return;
      // Conservative mode: unwatched threads only alert on failure; watched threads alert on completion or failure.
      if (status === "completed" && watch === undefined) return;

      const shell = yield* projections
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;

      const detail =
        status === "failed"
          ? `run failed${shell.lastError ? `: ${shell.lastError.slice(0, 140)}` : ""}`
          : `watched run completed${watch?.note ? ` (watch note: ${watch.note})` : ""}`;

      if (watch !== undefined && watch.until === "turn_end") {
        yield* commander.unwatchThread({ threadId: event.threadId });
      }
      yield* enqueueNotice({
        key: `run:${event.threadId}:${event.payload.id}`,
        environmentLabel: "local",
        threadId: event.threadId,
        title: shell.title,
        summary: detail,
        urgent: status === "failed",
      });
      return;
    }

    if (event.type === "thread.settled" && watch !== undefined) {
      const shell = yield* projections
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (watch.until === "settled" || watch.until === "turn_end") {
        yield* commander.unwatchThread({ threadId: event.threadId });
      }
      yield* enqueueNotice({
        key: `settled:${event.threadId}`,
        environmentLabel: "local",
        threadId: event.threadId,
        title: shell?.title ?? watch.title ?? String(event.threadId),
        summary: `watched thread settled${watch.note ? ` (${watch.note})` : ""}`,
        urgent: false,
      });
    }
  });

  const pollRemoteWatches = Effect.fn("CommanderWatchReactor.pollRemoteWatches")(function* () {
    const watches = yield* commander.listWatches;
    const remoteWatches = watches.filter((w) => w.environmentId !== undefined);
    if (remoteWatches.length === 0) return;

    const byEnv = Map.groupBy(remoteWatches, (w) => w.environmentId!);
    for (const [envId, envWatches] of byEnv) {
      const res = yield* peerClient
        .call({
          environmentId: envId,
          tool: "t3_thread_list",
          arguments: { allProjects: true, limit: 50 },
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: OrchestratorMcpThreadListResult,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (res === null) continue;
      const byId = new Map(res.threads.map((t) => [t.threadId, t]));
      for (const watch of envWatches) {
        const current = byId.get(watch.threadId);
        if (current === undefined) continue;
        const prevStatus = watch.lastSeenStatus;
        const prevRunId = watch.lastSeenRunId;
        yield* commander.updateWatchSnapshot({
          environmentId: envId,
          threadId: watch.threadId,
          status: current.status,
          runId: current.latestRunId,
        });
        if (prevStatus === undefined) continue;
        const transitionedToTerminal =
          (current.status === "completed" ||
            current.status === "failed" ||
            current.status === "idle") &&
          (prevStatus === "running" ||
            prevStatus === "starting" ||
            prevStatus === "preparing" ||
            prevStatus === "waiting" ||
            prevStatus === "queued" ||
            (current.latestRunId !== null && current.latestRunId !== prevRunId));
        const transitionedToSettled = current.settled && watch.until === "settled";
        if (transitionedToTerminal || transitionedToSettled) {
          if (watch.until === "turn_end" || transitionedToSettled) {
            yield* commander.unwatchThread({ environmentId: envId, threadId: watch.threadId });
          }
          yield* enqueueNotice({
            key: `remote:${envId}:${watch.threadId}:${current.latestRunId ?? current.status}`,
            environmentId: envId,
            environmentLabel: String(envId),
            threadId: watch.threadId,
            title: current.title,
            summary: transitionedToSettled
              ? `watched remote thread settled`
              : `watched remote thread finished (${current.status})${watch.note ? ` (${watch.note})` : ""}`,
            urgent: current.status === "failed",
          });
        }
      }
    }
  });

  const checkContextRollover = Effect.fn("CommanderWatchReactor.checkContextRollover")(
    function* () {
      const state = yield* commander.getRolloverState;
      const threadId = state.threadId;
      if (threadId === null || state.pendingFreshContext) return;

      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "providerTurns", "runtimeRequests"], {
          latestProviderTurnUsageOnly: true,
          runtimeRequestStatuses: ["pending"],
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (records === null) return;

      const hasActiveRun = records.runs.some(
        (r) =>
          r.status === "preparing" ||
          r.status === "starting" ||
          r.status === "running" ||
          r.status === "waiting" ||
          r.status === "queued",
      );
      const hasPendingRequest = records.runtimeRequests.some((r) => r.status === "pending");
      const completedRuns = records.runs.filter((r) => r.status === "completed").length;
      const latestUsage = records.providerTurns
        .map((t) => t.tokenUsage)
        .filter((u) => u != null)
        .at(-1);

      const nowMs = yield* Clock.currentTimeMillis;
      const decision = shouldTriggerContextRollover({
        nowMs,
        isIdle: !hasActiveRun && !hasPendingRequest,
        pendingFreshContext: state.pendingFreshContext,
        contextTokensUsed: latestUsage?.usedTokens ?? null,
        contextWindowTokens: latestUsage?.maxTokens ?? null,
        completedRunsSinceRollover: Math.max(0, completedRuns - state.rolloverRunBaseline),
        lastRolloverAt: state.lastRolloverAt,
      });
      if (!decision.shouldRollover) return;

      yield* Effect.logInfo("Triggering Computer context rollover checkpoint", {
        threadId,
        reason: decision.reason,
        completedRuns,
      });

      const dispatched = yield* commander.dispatchWake({
        text: `[commander-rollover] Reason: ${decision.reason}. Write a crisp, up-to-date summary of active priorities, watched threads (with environmentId/threadId), and standing rules into STATE.md, then reply with a 1-line confirmation. The next turn will automatically start with a fresh context window.`,
        urgent: false,
        freshContext: false,
        bypassRateLimit: true,
      });
      if (!dispatched.dispatched) return;
      yield* commander.markPendingFreshContext({
        pending: true,
        rolloverRunBaseline: completedRuns + 1,
        lastRolloverAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      });
    },
  );

  const start = Effect.fn("CommanderWatchReactor.start")(function* () {
    if (!commander.enabled) return;

    // Provision Computer thread after server startup.
    yield* forkParked(
      Effect.sleep(Duration.seconds(3)).pipe(Effect.andThen(commander.ensureProvisioned)),
    );

    // Local orchestration domain events stream.
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => handleDomainEvent(event)),
    );

    // Remote watched-thread poll every 60s.
    yield* forkParked(
      Effect.repeat(
        pollRemoteWatches(),
        Schedule.spaced(Duration.millis(SKOFO_COMMANDER_PEER_POLL_INTERVAL_MS)),
      ),
    );

    // Context rollover check every 15 minutes.
    yield* forkParked(
      Effect.repeat(
        checkContextRollover(),
        Schedule.spaced(Duration.millis(SKOFO_COMMANDER_ROLLOVER_CHECK_INTERVAL_MS)),
      ),
    );
  });

  return CommanderWatchReactor.of({ start });
});

export const layer = Layer.effect(CommanderWatchReactor, make);
