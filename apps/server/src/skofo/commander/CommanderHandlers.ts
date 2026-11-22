// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  isListedThreadLineage,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as CommanderService from "./CommanderService.ts";
import { watchKey } from "./CommanderStore.ts";
import { CommanderToolkit } from "./CommanderTools.ts";

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

function runFleetQueryCli(
  scriptPath: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, OrchestratorMcpFailure> {
  return Effect.callback<string, OrchestratorMcpFailure>((resume) => {
    const child = NodeChildProcess.execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
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

export const layer = McpToolAccess.toLayer(CommanderToolkit, {
  skofo_work_board: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, commander } = yield* requireCommanderCaller;
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
