import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadListV2Items } from "../threads/threadListV2";
import {
  computeMobileCommanderStats,
  consumeMobileCommanderDictation,
  findCommanderThread,
  isCommanderThread,
  requestMobileCommanderDictation,
  SKOFO_COMMANDER_TAG,
} from "./commander";

const envA = EnvironmentId.make("env-a");
const proj1 = ProjectId.make("proj-1");

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: envA,
    id: ThreadId.make("thread-1"),
    projectId: proj1,
    title: "Normal task",
    createdAt: "2026-11-21T18:00:00.000Z",
    updatedAt: "2026-11-21T19:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lineage: { relationshipToParent: "root" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: { status: "idle" },
    latestRun: null,
    lastVisitedAt: null,
    pullRequests: [],
    source: { tags: [] },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("Mobile Commander helpers", () => {
  it("finds Computer by tag and excludes it from ThreadListV2 items", () => {
    const computer = makeShell({
      id: ThreadId.make("thread-computer"),
      title: "Computer",
      pinnedAt: "2026-11-21T18:00:00.000Z",
      source: { tags: [SKOFO_COMMANDER_TAG] } as unknown as EnvironmentThreadShell["source"],
    });
    const normal = makeShell({ id: ThreadId.make("thread-normal") });

    expect(isCommanderThread(computer)).toBe(true);
    expect(findCommanderThread([normal, computer])?.id).toBe("thread-computer");

    const layout = buildThreadListV2Items({
      threads: [computer, normal],
      environmentId: null,
      searchQuery: "",
      now: "2026-11-21T20:00:00.000Z",
    });
    expect(layout.items.map((item) => item.thread.id)).toEqual(["thread-normal"]);
  });

  it("computes mobile stats across all environments excluding Computer", () => {
    const computer = makeShell({
      id: ThreadId.make("thread-computer"),
      runtime: { status: "running" } as unknown as EnvironmentThreadShell["runtime"],
      source: { tags: [SKOFO_COMMANDER_TAG] } as unknown as EnvironmentThreadShell["source"],
    });
    const blocked = makeShell({
      id: ThreadId.make("t-block"),
      hasPendingUserInput: true,
      runtime: { status: "waiting" } as unknown as EnvironmentThreadShell["runtime"],
    });
    const failed = makeShell({
      id: ThreadId.make("t-fail"),
      runtime: { status: "failed" } as unknown as EnvironmentThreadShell["runtime"],
    });

    expect(
      computeMobileCommanderStats([computer, blocked, failed], `${envA}:thread-computer`),
    ).toEqual({ active: 2, working: 1, blocked: 1, failed: 1 });
  });

  it("handles mobile dictation request consumption and expiry", () => {
    requestMobileCommanderDictation("env-a:thread-computer", 1_000);
    expect(consumeMobileCommanderDictation("env-a:thread-computer", 2_000)).toBe(true);
    expect(consumeMobileCommanderDictation("env-a:thread-computer", 2_500)).toBe(false);
    requestMobileCommanderDictation("env-a:thread-computer", 3_000);
    expect(consumeMobileCommanderDictation("env-a:thread-computer", 20_000)).toBe(false);
  });
});
