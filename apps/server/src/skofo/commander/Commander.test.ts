import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as CommanderService from "./CommanderService.ts";
import * as CommanderStore from "./CommanderStore.ts";
import { formatCommanderEventBatch } from "./CommanderWatchReactor.ts";
import {
  SKOFO_COMMANDER_MAX_WAKES_PER_HOUR,
  SKOFO_COMMANDER_ROLLOVER_NIGHTLY_MIN_RUNS,
} from "./constants.ts";

const envId = EnvironmentId.make("env-test-local");
const commanderThreadId = ThreadId.make("thread-commander-1");
const normalThreadId = ThreadId.make("thread-normal-2");

const testClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

describe("CommanderStore pure rules", () => {
  it("upserts and removes watches cleanly by (environmentId, threadId)", () => {
    const w1: CommanderStore.CommanderWatch = {
      threadId: normalThreadId,
      title: "Fix deploy",
      until: "turn_end",
      createdAt: "2026-11-21T10:00:00.000Z",
    };
    const w2: CommanderStore.CommanderWatch = {
      environmentId: EnvironmentId.make("env-peer-1"),
      threadId: normalThreadId,
      title: "Peer build",
      until: "settled",
      createdAt: "2026-11-21T10:01:00.000Z",
    };

    let list = CommanderStore.upsertWatch([], w1);
    list = CommanderStore.upsertWatch(list, w2);
    expect(list).toHaveLength(2);

    // Updating the local watch preserves the remote one with the same threadId.
    list = CommanderStore.upsertWatch(list, { ...w1, note: "ping Lukas on completion" });
    expect(list).toHaveLength(2);
    expect(list.find((w) => w.environmentId === undefined)?.note).toBe("ping Lukas on completion");

    const removed = CommanderStore.removeWatch(list, { threadId: normalThreadId });
    expect(removed.removed).toBe(true);
    expect(removed.watches).toHaveLength(1);
    expect(removed.watches[0]?.environmentId).toBe("env-peer-1");
  });

  it("enforces quiet hours for non-urgent wakes, allows urgent wakes, and enforces hourly cap", () => {
    // 09:30 UTC = 02:30 UTC-7 (inside 23:00-07:30 quiet hours)
    const quietDate = Date.UTC(2026, 10, 21, 9, 30, 0);
    expect(
      CommanderStore.canAutoWake({ wakeTimestampsMs: [], nowMs: quietDate, urgent: false }),
    ).toEqual({ allowed: false, reason: "quiet_hours" });
    expect(
      CommanderStore.canAutoWake({ wakeTimestampsMs: [], nowMs: quietDate, urgent: true }),
    ).toEqual({ allowed: true });

    // 21:00 UTC = 14:00 UTC-7 (daytime)
    const dayDate = Date.UTC(2026, 10, 21, 21, 0, 0);
    const cappedStamps = Array.from(
      { length: SKOFO_COMMANDER_MAX_WAKES_PER_HOUR },
      (_, i) => dayDate - (i + 1) * 60_000,
    );
    expect(
      CommanderStore.canAutoWake({ wakeTimestampsMs: cappedStamps, nowMs: dayDate, urgent: false }),
    ).toEqual({ allowed: false, reason: "hourly_cap" });
    // Old timestamps (>1h ago) are pruned
    const oldStamps = Array.from(
      { length: SKOFO_COMMANDER_MAX_WAKES_PER_HOUR + 4 },
      (_, i) => dayDate - 4_000_000 - i * 60_000,
    );
    expect(
      CommanderStore.canAutoWake({ wakeTimestampsMs: oldStamps, nowMs: dayDate, urgent: false }),
    ).toEqual({ allowed: true });
  });

  it("triggers context rollover only when idle and threshold met", () => {
    // 11:15 UTC = 04:15 UTC-7 (inside nightly rollover window 04:00-04:30)
    const nightlyMs = Date.UTC(2026, 10, 21, 11, 15, 0);
    // 21:00 UTC = 14:00 UTC-7 (outside nightly window)
    const dayMs = Date.UTC(2026, 10, 21, 21, 0, 0);

    expect(
      CommanderStore.shouldTriggerContextRollover({
        nowMs: dayMs,
        isIdle: false,
        pendingFreshContext: false,
        contextTokensUsed: 900_000,
        contextWindowTokens: 1_000_000,
        completedRunsSinceRollover: 100,
        lastRolloverAt: null,
      }).shouldRollover,
    ).toBe(false);

    expect(
      CommanderStore.shouldTriggerContextRollover({
        nowMs: dayMs,
        isIdle: true,
        pendingFreshContext: false,
        contextTokensUsed: 650_000,
        contextWindowTokens: 1_000_000,
        completedRunsSinceRollover: 5,
        lastRolloverAt: null,
      }),
    ).toEqual({ shouldRollover: true, reason: "context_ratio" });

    expect(
      CommanderStore.shouldTriggerContextRollover({
        nowMs: nightlyMs,
        isIdle: true,
        pendingFreshContext: false,
        contextTokensUsed: 100_000,
        contextWindowTokens: 1_000_000,
        completedRunsSinceRollover: SKOFO_COMMANDER_ROLLOVER_NIGHTLY_MIN_RUNS,
        lastRolloverAt: null,
      }),
    ).toEqual({ shouldRollover: true, reason: "nightly_idle" });

    // Cooldown prevents thrashing right after a rollover
    expect(
      CommanderStore.shouldTriggerContextRollover({
        nowMs: dayMs,
        isIdle: true,
        pendingFreshContext: false,
        contextTokensUsed: 800_000,
        contextWindowTokens: 1_000_000,
        completedRunsSinceRollover: 50,
        lastRolloverAt: "2026-11-21T20:45:00.000Z",
      }).shouldRollover,
    ).toBe(false);
  });

  it.effect("persists state to skofo-commander.json sidecar and reloads it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "skofo-commander-store-" });
      const configLayer = ServerConfig.layerTest(tmpDir, { prefix: "skofo-commander-cfg-" });

      const resolvedConfig = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      const storeLayer = CommanderStore.layer.pipe(
        Layer.provide(Layer.succeed(ServerConfig.ServerConfig, resolvedConfig)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const store = yield* CommanderStore.CommanderStore;
        yield* store.update((s) => ({
          ...s,
          threadId: commanderThreadId,
          watches: [
            {
              threadId: normalThreadId,
              until: "turn_end",
              createdAt: "2026-11-21T12:00:00.000Z",
            },
          ],
        }));
      }).pipe(Effect.provide(storeLayer));

      const reloaded = yield* Effect.gen(function* () {
        const store = yield* CommanderStore.CommanderStore;
        return yield* store.get;
      }).pipe(Effect.provide(storeLayer));

      expect(reloaded.threadId).toBe(commanderThreadId);
      expect(reloaded.watches).toHaveLength(1);
      expect(reloaded.watches[0]?.threadId).toBe(normalThreadId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("summarizeShellAttention & formatCommanderEventBatch", () => {
  it("excludes Computer, settled, archived, and subagents from counts", () => {
    const mkShell = (overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell =>
      ({
        id: ThreadId.make("t-default"),
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        lineage: { relationshipToParent: "root" },
        pendingRuntimeRequest: null,
        status: "idle",
        ...overrides,
      }) as unknown as OrchestrationV2ThreadShell;

    const counts = CommanderService.summarizeShellAttention(
      [
        mkShell({ id: commanderThreadId, status: "running" }),
        mkShell({ id: ThreadId.make("t-working"), status: "running" }),
        mkShell({
          id: ThreadId.make("t-blocked"),
          status: "waiting",
          pendingRuntimeRequest: {
            id: "req-1",
            kind: "user_input",
          } as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        }),
        mkShell({ id: ThreadId.make("t-failed"), status: "failed" }),
        mkShell({ id: ThreadId.make("t-settled"), settledOverride: "settled", status: "failed" }),
        mkShell({
          id: ThreadId.make("t-subagent"),
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: normalThreadId,
          } as unknown as OrchestrationV2ThreadShell["lineage"],
          status: "running",
        }),
      ],
      commanderThreadId,
    );

    expect(counts).toEqual({ active: 3, working: 2, blocked: 1, failed: 1 });
  });

  it("formats commander event batches cleanly", () => {
    const text = formatCommanderEventBatch([
      {
        key: "run:t1:r1",
        environmentLabel: "local",
        threadId: normalThreadId,
        title: "Deploy check",
        summary: "run failed: timeout",
        urgent: true,
      },
    ]);
    expect(text).toContain("[commander-event]");
    expect(text).toContain("Deploy check");
    expect(text).toContain("t3_thread_read");
  });
});

describe("Commander MCP visibility & isolation", () => {
  const makeTestMcpLayer = () => {
    const watches: CommanderStore.CommanderWatch[] = [];
    const mockCommander = Layer.succeed(
      CommanderService.CommanderService,
      CommanderService.CommanderService.of({
        enabled: true,
        workspaceDir: "/tmp/nonexistent-commander",
        ensureProvisioned: Effect.succeed(null),
        getCommanderThreadId: Effect.succeed(commanderThreadId),
        isCommanderThread: (id) => Effect.succeed(id === commanderThreadId),
        getSummary: Effect.die("unused"),
        getRolloverState: Effect.die("unused"),
        listWatches: Effect.sync(() => [...watches]),
        watchThread: (input) =>
          Effect.sync(() => {
            const entry: CommanderStore.CommanderWatch = {
              ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
              threadId: input.threadId,
              ...(input.title === undefined ? {} : { title: input.title }),
              until: input.until ?? "turn_end",
              ...(input.note === undefined ? {} : { note: input.note }),
              createdAt: "2026-11-21T20:00:00.000Z",
            };
            watches.push(entry);
            return entry;
          }),
        unwatchThread: (input) =>
          Effect.sync(() => {
            const idx = watches.findIndex(
              (w) => w.threadId === input.threadId && w.environmentId === input.environmentId,
            );
            if (idx >= 0) {
              watches.splice(idx, 1);
              return { removed: true };
            }
            return { removed: false };
          }),
        updateWatchSnapshot: () => Effect.void,
        dispatchWake: () => Effect.succeed({ dispatched: true }),
        consumePendingFreshContext: Effect.succeed(false),
        markPendingFreshContext: () => Effect.void,
      }),
    );

    const mockDeps = Layer.mergeAll(
      mockCommander,
      NodeServices.layer,
      McpToolAccessTestkit.liveThreadsLayer,
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
      } as unknown as ProjectionStore.ProjectionStoreV2Shape),
      Layer.succeed(PeerLinks.PeerLinks, {
        list: Effect.succeed([]),
      } as unknown as PeerLinks.PeerLinks["Service"]),
      Layer.succeed(
        PeerMcpClient.PeerMcpClient,
        {} as unknown as PeerMcpClient.PeerMcpClient["Service"],
      ),
      Layer.succeed(ScheduledTasks.ScheduledTaskService, {
        list: () => Effect.succeed({ tasks: [] }),
      } as unknown as ScheduledTasks.ScheduledTaskService["Service"]),
    );

    return McpHttpServer.layerCommander.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(mockDeps),
    );
  };

  const makeScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
    environmentId: envId,
    requestNamespace: `sess-${threadId}`,
    thread: {
      threadId,
      providerSessionId: `sess-${threadId}`,
      providerInstanceId: ProviderInstanceId.make("antigravity"),
    },
    client: undefined,
    capabilities: new Set(),
    issuedAt: 1,
  });

  it.effect(
    "blocks regular threads from calling skofo_* tools and registers all 6 tools cleanly",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const toolNames = server.tools.map(({ tool }) => tool.name);
        const normalDenied = yield* server
          .callTool({ name: "skofo_list_watches", arguments: {} })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              makeScope(normalThreadId),
            ),
            Effect.provideService(McpSchema.McpServerClient, testClient),
            Effect.result,
          );

        expect(toolNames).toContain("skofo_work_board");
        expect(toolNames).toContain("skofo_watch_thread");
        expect(toolNames).toContain("skofo_unwatch_thread");
        expect(toolNames).toContain("skofo_list_watches");
        expect(toolNames).toContain("skofo_fleet_query");
        expect(toolNames).toContain("skofo_memory_search");

        // Visibility rejects non-Computer callers (Err) or handler returns capability_denied (isError: true).
        if (Result.isSuccess(normalDenied)) {
          expect(normalDenied.success.isError).toBe(true);
        }
      }).pipe(Effect.provide(makeTestMcpLayer())),
  );

  it.effect(
    "allows Computer to watch/list/unwatch and blocks emails search without explicit opt-in",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const callAs = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(threadId)),
              Effect.provideService(McpSchema.McpServerClient, testClient),
            );

        const watchRes = yield* callAs(commanderThreadId, "skofo_watch_thread", {
          threadId: normalThreadId,
          title: "Tracked task",
          until: "turn_end",
        });
        const listRes = yield* callAs(commanderThreadId, "skofo_list_watches", {});
        const emailDenied = yield* callAs(commanderThreadId, "skofo_memory_search", {
          query: "invoice",
          collection: "emails",
        });
        const unwatchRes = yield* callAs(commanderThreadId, "skofo_unwatch_thread", {
          threadId: normalThreadId,
        });

        expect(watchRes.isError).not.toBe(true);
        expect(listRes.isError).not.toBe(true);
        expect(JSON.stringify(listRes.content)).toContain(normalThreadId);
        expect(emailDenied.isError).toBe(true);
        expect(JSON.stringify(emailDenied.content)).toContain("explicit owner approval");
        expect(unwatchRes.isError).not.toBe(true);
      }).pipe(Effect.provide(makeTestMcpLayer())),
  );
});
