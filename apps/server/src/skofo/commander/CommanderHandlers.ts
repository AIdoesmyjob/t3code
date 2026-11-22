// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";

import {
  isListedThreadLineage,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadListItem,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { isSnoozed } from "../../orchestration-v2/ThreadSettlementService.ts";
import { visibleThreadPullRequests } from "../../sourceControl/threadPullRequests.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as CommanderService from "./CommanderService.ts";
import { watchKey } from "./CommanderStore.ts";
import { CommanderToolkit } from "./CommanderTools.ts";
import { boundBriefWorkBoard, selectBriefWorkBoard } from "./CommanderWorkBoard.ts";

const requireCommanderCaller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const commander = yield* CommanderService.CommanderService;
  const allowed = yield* commander.isCommanderThread(scope.thread?.threadId);
  if (!allowed) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This tool is reserved for the persistent Computer thread.",
    });
  }
  return { scope, commander };
});

// Never use process.execPath: in a compiled SEA binary that points to the t3 CLI, not node.
const FLEET_QUERY_NODE_BIN = NodeProcess.env.SKOFO_COMMANDER_NODE_BIN?.trim() || "node";

function runFleetQueryCli(
  scriptPath: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, OrchestratorMcpFailure> {
  return Effect.callback<string, OrchestratorMcpFailure>((resume) => {
    const child = NodeChildProcess.execFile(
      FLEET_QUERY_NODE_BIN,
      [scriptPath, ...args],
      {
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...NodeProcess.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: (stderr || error.message || "fleet-query failed").trim().slice(0, 600),
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed(stdout.trim()));
      },
    );
    return Effect.sync(() => {
      child.kill("SIGTERM");
    });
  });
}

const ACTIVE_STATUSES = new Set(["preparing", "starting", "running", "waiting", "queued"]);

const loadPeerBoardThreads = Effect.fn("Commander.loadPeerBoardThreads")(function* (
  peerClient: PeerMcpClient.PeerMcpClient["Service"],
  environmentId: EnvironmentId,
) {
  const threads = new Map<string, OrchestratorMcpThreadListItem>();
  let cursor = 0;
  while (true) {
    const page = yield* peerClient.call({
      environmentId,
      tool: "t3_thread_list",
      arguments: {
        allProjects: true,
        settled: false,
        snoozed: false,
        includeSubagents: false,
        includeLatestActivity: true,
        limit: 100,
        cursor,
      },
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      success: OrchestratorMcpThreadListResult,
    });
    for (const thread of page.threads) threads.set(thread.threadId, thread);
    if (page.nextCursor === null) return Array.from(threads.values());
    if (page.nextCursor <= cursor) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The linked work board returned an invalid thread cursor.",
      });
    }
    cursor = page.nextCursor;
  }
});

const readBriefPeer = Effect.fn("Commander.readBriefPeer")(function* (
  peerClient: PeerMcpClient.PeerMcpClient["Service"],
  scope: McpInvocationContext.McpInvocationScope,
  link: PeerLinkSummary,
  watchedKeys: ReadonlySet<string>,
) {
  const machine = { environmentId: link.environmentId, label: link.label };
  const lastContact = link.lastReachedAt === null ? null : DateTime.formatIso(link.lastReachedAt);
  if (link.status !== "reachable") {
    return { ...machine, status: link.status, freshAt: lastContact, rows: [] };
  }
  const threads = yield* loadPeerBoardThreads(peerClient, link.environmentId).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!threads)
    return { ...machine, status: "unreachable" as const, freshAt: lastContact, rows: [] };
  return {
    ...machine,
    status: "reachable" as const,
    freshAt: DateTime.formatIso(yield* DateTime.now),
    rows: threads.map((t) => {
      const openPrCount = t.openPullRequestCount ?? 0;
      const primaryPr =
        t.pullRequests?.find((pr) => pr.state === "open") ??
        (openPrCount > 0 ? t.linkedPullRequest : null);
      const pendingKind =
        t.pendingRequestKind ??
        (t.blockedOnThreadWait
          ? "thread_wait"
          : t.pendingRequestKind === undefined &&
              t.status === "waiting" &&
              (t.pendingBackgroundTasks?.length ?? 0) === 0
            ? "waiting"
            : undefined);
      return {
        environmentId: link.environmentId,
        machine: link.label,
        threadId: t.threadId,
        title: t.title,
        link:
          t.link ??
          McpInvocationContext.threadLinkFor(
            { ...scope, environmentId: link.environmentId },
            t.threadId,
            t.title,
          ),
        status: t.status,
        ...(pendingKind ? { pendingKind } : {}),
        watched: watchedKeys.has(
          watchKey({ threadId: t.threadId, environmentId: link.environmentId }),
        ),
        openPrCount,
        ...(primaryPr ? { primaryPr: { url: primaryPr.url, number: primaryPr.number } } : {}),
        updatedAt: t.updatedAt,
        latestActivity:
          t.latestActivity == null
            ? null
            : Array.from(t.latestActivity.replace(/\s+/gu, " ").trim()).slice(0, 160).join(""),
      };
    }),
  };
});

const readBriefWorkBoard = Effect.fn("Commander.readBriefWorkBoard")(function* (input: {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly commander: CommanderService.CommanderService["Service"];
  readonly includeIdle: boolean;
}) {
  const { scope, commander, includeIdle } = input;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const peerClient = yield* PeerMcpClient.PeerMcpClient;
  const commanderThreadId = yield* commander.getCommanderThreadId;
  const watches = yield* commander.listWatches;
  const watchedKeys = new Set(watches.map(watchKey));
  const now = yield* DateTime.now;
  const label = NodeOS.hostname();

  const [snapshot, links] = yield* Effect.all(
    [
      projections
        .getShellSnapshot({ location: "active", unsettledOnly: true })
        .pipe(Effect.orElseSucceed(() => null)),
      peerLinks.list.pipe(Effect.orElseSucceed(() => null)),
    ],
    { concurrency: 2 },
  );
  const peers = yield* Effect.forEach(
    links ?? [],
    (link) => readBriefPeer(peerClient, scope, link, watchedKeys),
    { concurrency: 4 },
  );
  const local = {
    environmentId: scope.environmentId,
    label,
    status: snapshot ? ("reachable" as const) : ("unreachable" as const),
    freshAt: snapshot ? DateTime.formatIso(now) : null,
    rows: (snapshot?.threads ?? [])
      .filter(
        (t) =>
          t.id !== commanderThreadId &&
          t.archivedAt === null &&
          t.deletedAt === null &&
          t.settledOverride !== "settled" &&
          !isSnoozed(t, DateTime.toEpochMillis(now)) &&
          isListedThreadLineage(t.lineage),
      )
      .map((t) => {
        const openPrs = visibleThreadPullRequests(t.pullRequests ?? []).filter(
          (pr) => pr.snapshot?.state === "open",
        );
        const primaryPr = openPrs.find((pr) => pr.watch !== undefined) ?? openPrs[0];
        const pendingKind =
          t.pendingRuntimeRequest?.kind ?? (t.blockedOnThreadWait ? "thread_wait" : undefined);
        const status =
          t.activityRunStatus ??
          (t.status !== "failed" && backgroundWorkHoldsCompletion(t.pendingBackgroundTasks ?? [])
            ? "waiting"
            : t.status);
        return {
          environmentId: scope.environmentId,
          machine: label,
          threadId: t.id,
          title: t.title,
          link: McpInvocationContext.threadLinkFor(scope, t.id, t.title),
          status,
          ...(pendingKind ? { pendingKind } : {}),
          watched:
            watchedKeys.has(watchKey({ threadId: t.id })) ||
            watchedKeys.has(watchKey({ environmentId: scope.environmentId, threadId: t.id })),
          openPrCount: openPrs.length,
          ...(primaryPr ? { primaryPr: { url: primaryPr.url, number: primaryPr.number } } : {}),
          updatedAt: DateTime.formatIso(t.updatedAt),
          latestActivity: null,
        };
      }),
  };

  const board = selectBriefWorkBoard({
    asOf: DateTime.formatIso(yield* DateTime.now),
    includeIdle,
    machines: [local, ...peers],
    peerDiscovery: links === null ? "unavailable" : "available",
  });
  const localIds = board.rows
    .filter((row) => row.environmentId === scope.environmentId)
    .map((row) => row.threadId);
  const activity =
    localIds.length === 0
      ? new Map()
      : yield* projections
          .getLatestThreadActivity(localIds)
          .pipe(Effect.orElseSucceed(() => new Map()));
  return boundBriefWorkBoard({
    ...board,
    rows: board.rows.map((row) =>
      row.environmentId === scope.environmentId
        ? { ...row, latestActivity: activity.get(row.threadId) ?? null }
        : row,
    ),
  });
});

export const layer = McpToolAccess.toLayer(CommanderToolkit, {
  skofo_work_board: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, commander } = yield* requireCommanderCaller;
      if (input.view !== "full") {
        return yield* readBriefWorkBoard({
          scope,
          commander,
          includeIdle: input.includeIdle !== false,
        });
      }

      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const peerLinks = yield* PeerLinks.PeerLinks;
      const peerClient = yield* PeerMcpClient.PeerMcpClient;
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;

      const includeIdle = input.includeIdle !== false;
      const limitPerMachine = Math.max(5, Math.min(50, Math.floor(input.limitPerMachine ?? 20)));
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const commanderThreadId = yield* commander.getCommanderThreadId;
      const watches = yield* commander.listWatches;
      const watchedKeys = new Set(watches.map((w) => watchKey(w)));

      // 1. Local threads on t3code-dev
      const localSnapshot = yield* projections
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.orElseSucceed(() => null));
      const localShells = (localSnapshot?.threads ?? []).filter(
        (t) =>
          t.id !== commanderThreadId &&
          t.archivedAt === null &&
          t.deletedAt === null &&
          t.settledOverride !== "settled" &&
          isListedThreadLineage(t.lineage),
      );

      let localWorking = 0;
      let localBlocked = 0;
      let localFailed = 0;
      const localEntries = localShells
        .map((t) => {
          const isWorking = ACTIVE_STATUSES.has(t.status);
          const isBlocked = t.pendingRuntimeRequest !== null;
          const isFailed = t.status === "failed";
          if (isWorking) localWorking += 1;
          if (isBlocked) localBlocked += 1;
          if (isFailed) localFailed += 1;
          const openPrs = (t.pullRequests ?? []).filter(
            (pr) => pr.snapshot?.state === "open",
          ).length;
          return {
            environmentId: scope.environmentId,
            environmentLabel: "local",
            threadId: t.id,
            title: t.title,
            link: McpInvocationContext.threadLinkFor(scope, t.id, t.title),
            status: t.status,
            pendingRequestKind: t.pendingRuntimeRequest?.kind ?? null,
            pinned: t.pinnedAt != null,
            watched:
              watchedKeys.has(watchKey({ threadId: t.id })) ||
              watchedKeys.has(watchKey({ environmentId: scope.environmentId, threadId: t.id })),
            openPullRequests: openPrs,
            updatedAt: DateTime.formatIso(t.updatedAt),
            _priority: (isBlocked ? 4 : 0) + (isFailed ? 3 : 0) + (isWorking ? 2 : 0),
          };
        })
        .filter((e) => includeIdle || e._priority > 0 || e.watched)
        .toSorted((a, b) => b._priority - a._priority || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limitPerMachine)
        .map(({ _priority: _drop, ...rest }) => rest);

      const localMachine = {
        environmentId: scope.environmentId,
        label: "local",
        reachable: true,
        activeCount: localShells.length,
        workingCount: localWorking,
        blockedCount: localBlocked,
        failedCount: localFailed,
        threads: localEntries,
      };

      // 2. Linked peer machines in parallel
      const links = yield* peerLinks.list.pipe(Effect.orElseSucceed(() => []));
      const peerMachines = yield* Effect.forEach(
        links,
        (link) =>
          peerClient
            .call({
              environmentId: link.environmentId,
              tool: "t3_thread_list",
              arguments: {
                allProjects: true,
                settled: false,
                snoozed: false,
                limit: limitPerMachine,
              },
              limits: { runtimeMode: "full-access", interactionMode: "default" },
              success: OrchestratorMcpThreadListResult,
            })
            .pipe(
              Effect.map((res) => {
                let workingCount = 0;
                let blockedCount = 0;
                let failedCount = 0;
                const mapped = res.threads
                  .map((t) => {
                    const isWorking = ACTIVE_STATUSES.has(t.status);
                    const isBlocked = t.status === "waiting" || t.blockedOnThreadWait === true;
                    const isFailed = t.status === "failed";
                    if (isWorking) workingCount += 1;
                    if (isBlocked) blockedCount += 1;
                    if (isFailed) failedCount += 1;
                    return {
                      environmentId: link.environmentId,
                      environmentLabel: link.label,
                      threadId: t.threadId,
                      title: t.title,
                      link:
                        t.link ??
                        McpInvocationContext.threadLinkFor(
                          { ...scope, environmentId: link.environmentId },
                          t.threadId,
                          t.title,
                        ),
                      status: t.status,
                      pendingRequestKind: null,
                      pinned: t.pinned === true,
                      watched: watchedKeys.has(
                        watchKey({ environmentId: link.environmentId, threadId: t.threadId }),
                      ),
                      openPullRequests: t.openPullRequestCount ?? 0,
                      updatedAt: t.updatedAt,
                    };
                  })
                  .filter(
                    (e) =>
                      includeIdle ||
                      ACTIVE_STATUSES.has(e.status) ||
                      e.status === "failed" ||
                      e.watched,
                  );
                return {
                  environmentId: link.environmentId,
                  label: link.label,
                  reachable: true,
                  activeCount: res.total,
                  workingCount,
                  blockedCount,
                  failedCount,
                  threads: mapped,
                };
              }),
              Effect.catch((err) =>
                Effect.succeed({
                  environmentId: link.environmentId,
                  label: link.label,
                  reachable: false,
                  error: err.message,
                  activeCount: 0,
                  workingCount: 0,
                  blockedCount: 0,
                  failedCount: 0,
                  threads: [],
                }),
              ),
            ),
        { concurrency: 4 },
      );

      // 3. Scheduled fleet jobs summary
      const scheduled = yield* scheduler.list().pipe(
        Effect.map(({ tasks }) =>
          tasks.map((task) => ({
            id: String(task.id),
            title: task.title,
            enabled: task.enabled,
            lastRunStatus: task.lastRunStatus,
            nextRunAt: task.nextRunAt,
          })),
        ),
        Effect.orElseSucceed(() => []),
      );

      return {
        generatedAt: nowIso,
        machines: [localMachine, ...peerMachines],
        watches,
        scheduledTasks: scheduled,
      };
    }),
  ),

  skofo_watch_thread: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { commander } = yield* requireCommanderCaller;
      const watch = yield* commander.watchThread(input);
      return { watch };
    }),
  ),

  skofo_unwatch_thread: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { commander } = yield* requireCommanderCaller;
      return yield* commander.unwatchThread(input);
    }),
  ),

  skofo_list_watches: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { commander } = yield* requireCommanderCaller;
      const watches = yield* commander.listWatches;
      const filtered =
        input.environmentId === undefined
          ? watches
          : watches.filter((w) => w.environmentId === input.environmentId);
      return { watches: filtered };
    }),
  ),

  skofo_fleet_query: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { commander } = yield* requireCommanderCaller;
      const path = yield* Path.Path;
      const scriptPath = path.join(commander.workspaceDir, "bin", "fleet-query.mjs");
      const args = input.target ? [input.query, input.target] : [input.query];
      const output = yield* runFleetQueryCli(scriptPath, args);
      return { output };
    }),
  ),

  skofo_memory_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { commander } = yield* requireCommanderCaller;
      const path = yield* Path.Path;
      if (input.collection === "emails" && input.includeEmails !== true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Searching the emails collection requires explicit owner approval (includeEmails: true).",
        });
      }
      const scriptPath = path.join(commander.workspaceDir, "bin", "fleet-query.mjs");
      const args = ["memory", input.query];
      if (input.limit !== undefined) {
        args.push("--limit", String(Math.max(1, Math.min(15, Math.floor(input.limit)))));
      }
      if (input.collection !== undefined) {
        args.push("--collection", input.collection);
      }
      if (input.includeEmails === true) {
        args.push("--include-emails");
      }
      const output = yield* runFleetQueryCli(scriptPath, args);
      return { output };
    }),
  ),
});
