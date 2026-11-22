import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads } from "../../components/Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import {
  commanderHasUnreadCompletion,
  computeCommanderSidebarStats,
  consumeCommanderDictation,
  findCommanderThread,
  isCommanderThread,
  requestCommanderDictation,
  SKOFO_COMMANDER_TAG,
  subscribeCommanderDictation,
} from "./commanderConstants";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const proj1 = ProjectId.make("proj-1");

function makeShell(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    environmentId: envA,
    id: ThreadId.make("thread-1"),
    projectId: proj1,
    title: "Normal thread",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: "root" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: { status: "idle" },
    latestRun: null,
    lastVisitedAt: null,
    source: { tags: [] },
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

describe("Web Commander helpers", () => {
  it("identifies Computer by skofo:commander tag and excludes it from regular sidebar threads", () => {
    const computer = makeShell({
      id: ThreadId.make("thread-computer"),
      title: "Computer",
      source: { tags: [SKOFO_COMMANDER_TAG] } as unknown as SidebarThreadSummary["source"],
    });
    const regular = makeShell({ id: ThreadId.make("thread-regular") });

    expect(isCommanderThread(computer)).toBe(true);
    expect(isCommanderThread(regular)).toBe(false);
    expect(findCommanderThread([regular, computer])?.id).toBe("thread-computer");

    const visible = filterSidebarV2VisibleThreads([regular, computer], null, new Set());
    expect(visible.map((t) => t.id)).toEqual(["thread-regular"]);
  });

  it("computes cross-machine attention stats while excluding Computer, settled, and subagents", () => {
    const computer = makeShell({
      id: ThreadId.make("thread-computer"),
      runtime: { status: "running" } as unknown as SidebarThreadSummary["runtime"],
      source: { tags: [SKOFO_COMMANDER_TAG] } as unknown as SidebarThreadSummary["source"],
    });
    const working = makeShell({
      id: ThreadId.make("t-work"),
      environmentId: envB,
      runtime: { status: "running" } as unknown as SidebarThreadSummary["runtime"],
    });
    const blocked = makeShell({
      id: ThreadId.make("t-block"),
      hasPendingApprovals: true,
      runtime: { status: "waiting" } as unknown as SidebarThreadSummary["runtime"],
    });
    const failed = makeShell({
      id: ThreadId.make("t-fail"),
      runtime: { status: "failed" } as unknown as SidebarThreadSummary["runtime"],
    });
    const settled = makeShell({
      id: ThreadId.make("t-settled"),
      settledOverride: "settled",
      runtime: { status: "failed" } as unknown as SidebarThreadSummary["runtime"],
    });
    const subagent = makeShell({
      id: ThreadId.make("t-sub"),
      lineage: {
        relationshipToParent: "subagent",
        parentThreadId: ThreadId.make("t-work"),
      } as unknown as SidebarThreadSummary["lineage"],
      runtime: { status: "running" } as unknown as SidebarThreadSummary["runtime"],
    });

    expect(
      computeCommanderSidebarStats(
        [computer, working, blocked, failed, settled, subagent],
        `${envA}:thread-computer`,
      ),
    ).toEqual({ active: 3, working: 2, blocked: 1, failed: 1 });
  });

  it("detects unread Computer completions accurately", () => {
    expect(
      commanderHasUnreadCompletion({
        latestRun: {
          status: "completed",
          completedAt: "2026-11-21T20:05:00.000Z",
        } as unknown as SidebarThreadSummary["latestRun"],
        lastVisitedAt: "2026-11-21T20:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      commanderHasUnreadCompletion({
        latestRun: {
          status: "completed",
          completedAt: "2026-11-21T19:55:00.000Z",
        } as unknown as SidebarThreadSummary["latestRun"],
        lastVisitedAt: "2026-11-21T20:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("handles dictation requests with subscription and TTL expiry", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommanderDictation((key) => seen.push(key));
    requestCommanderDictation("env-a:thread-computer", 1_000);
    expect(seen).toEqual(["env-a:thread-computer"]);
    expect(consumeCommanderDictation("env-a:other", 1_500)).toBe(false);
    expect(consumeCommanderDictation("env-a:thread-computer", 1_500)).toBe(true);
    expect(consumeCommanderDictation("env-a:thread-computer", 1_600)).toBe(false);

    requestCommanderDictation("env-a:thread-computer", 2_000);
    expect(consumeCommanderDictation("env-a:thread-computer", 20_000)).toBe(false);
    unsubscribe();
  });
});
