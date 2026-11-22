import {
  EnvironmentId,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as CommanderService from "./CommanderService.ts";
import { CommanderWatch, CommanderWatchUntil } from "./CommanderStore.ts";

import { BriefWorkBoard } from "./CommanderWorkBoard.ts";

const WorkBoardThreadEntry = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  threadId: ThreadId,
  title: Schema.String,
  link: Schema.String,
  status: Schema.String,
  pendingRequestKind: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  watched: Schema.Boolean,
  openPullRequests: NonNegativeInt,
  updatedAt: Schema.String,
});

const WorkBoardMachineSummary = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  reachable: Schema.Boolean,
  error: Schema.optional(Schema.String),
  activeCount: NonNegativeInt,
  workingCount: NonNegativeInt,
  blockedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  threads: Schema.Array(WorkBoardThreadEntry),
});

const WorkBoardTool = Tool.make("skofo_work_board", {
  description:
    "One-call fleet work board for Computer. Brief (default) gives reachability, totals and prioritized thread updates. Full adds detailed watches and scheduled jobs.",
  parameters: Schema.Struct({
    view: Schema.optional(Schema.Literals(["brief", "full"])),
    includeIdle: Schema.optional(Schema.Boolean),
    limitPerMachine: Schema.optional(PositiveInt),
  }),
  success: Schema.Union([
    BriefWorkBoard,
    Schema.Struct({
      generatedAt: Schema.String,
      machines: Schema.Array(WorkBoardMachineSummary),
      watches: Schema.Array(CommanderWatch),
      scheduledTasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          enabled: Schema.Boolean,
          lastRunStatus: Schema.NullOr(Schema.String),
          nextRunAt: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CommanderService.CommanderService,
    ProjectionStore.ProjectionStoreV2,
    PeerLinks.PeerLinks,
    PeerMcpClient.PeerMcpClient,
    ScheduledTasks.ScheduledTaskService,
  ],
})
  .annotate(Tool.Title, "Cross-machine work board")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchThreadTool = Tool.make("skofo_watch_thread", {
  description:
    "Watch a local or linked-machine thread so Computer wakes automatically when it completes, fails, hits a limit, or settles.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(EnvironmentId),
    threadId: ThreadId,
    title: Schema.optional(TrimmedNonEmptyString),
    until: Schema.optional(CommanderWatchUntil),
    note: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    watch: CommanderWatch,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, CommanderService.CommanderService],
})
  .annotate(Tool.Title, "Watch a thread for updates")
  .annotate(Tool.Destructive, false);

const UnwatchThreadTool = Tool.make("skofo_unwatch_thread", {
  description: "Stop watching a thread for automatic Computer follow-up wakes.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(EnvironmentId),
    threadId: ThreadId,
  }),
  success: Schema.Struct({
    removed: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, CommanderService.CommanderService],
})
  .annotate(Tool.Title, "Unwatch a thread")
  .annotate(Tool.Destructive, false);

const ListWatchesTool = Tool.make("skofo_list_watches", {
  description: "List all threads Computer is currently watching across local and linked machines.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(EnvironmentId),
  }),
  success: Schema.Struct({
    watches: Schema.Array(CommanderWatch),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, CommanderService.CommanderService],
})
  .annotate(Tool.Title, "List watched threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FleetQueryTool = Tool.make("skofo_fleet_query", {
  description:
    "Read-only live fleet and project query: vms (live Proxmox + Tech-Infra merge with drift flags), project (canonical repo, live path, runbook, open PRs), service (host, IP, runbooks), health (Proxmox + backup-assurance + appraisal), or snapshot.",
  parameters: Schema.Struct({
    query: Schema.Literals(["vms", "project", "service", "health", "snapshot"]),
    target: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    output: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CommanderService.CommanderService,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Query live fleet and projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MemorySearchTool = Tool.make("skofo_memory_search", {
  description:
    "Search Vector Memory (knowledge, conversations, research) and startrek-computer docs. Strictly excludes the emails collection unless includeEmails is explicitly set true by owner request.",
  parameters: Schema.Struct({
    query: TrimmedNonEmptyString,
    limit: Schema.optional(PositiveInt),
    collection: Schema.optional(
      Schema.Literals(["knowledge", "conversations", "research", "emails"]),
    ),
    includeEmails: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    output: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CommanderService.CommanderService,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Search fleet memory and docs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const CommanderToolkit = Toolkit.make(
  WorkBoardTool,
  WatchThreadTool,
  UnwatchThreadTool,
  ListWatchesTool,
  FleetQueryTool,
  MemorySearchTool,
);
