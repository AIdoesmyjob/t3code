import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { SidebarThreadSummary } from "../../types";
import { CommanderSidebarCard } from "./CommanderSidebarCard";
import { consumeCommanderDictation, SKOFO_COMMANDER_TAG } from "./commanderConstants";

const envId = EnvironmentId.make("env-local");
const threadId = ThreadId.make("thread-computer-browser");

function makeComputerShell(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    environmentId: envId,
    id: threadId,
    projectId: ProjectId.make("proj-computer"),
    title: "Computer",
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
    source: { tags: [SKOFO_COMMANDER_TAG] },
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

describe("CommanderSidebarCard browser", () => {
  it("renders Computer with live attention status, voice button, side-open button, and shortcut", async () => {
    const onOpen = vi.fn();
    const onOpenToSide = vi.fn();
    const screen = await render(
      <TooltipProvider>
        <CommanderSidebarCard
          thread={makeComputerShell()}
          stats={{ active: 4, working: 2, blocked: 1, failed: 0 }}
          isActive={false}
          onOpen={onOpen}
          onOpenToSide={onOpenToSide}
        />
      </TooltipProvider>,
    );

    await expect.element(screen.getByText("Computer")).toBeVisible();
    await expect.element(screen.getByText("1 waiting")).toBeVisible();

    // Click main card opens Computer
    await userEvent.click(screen.getByText("Computer"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ environmentId: envId, threadId });

    // Click Voice button queues dictation and opens Computer
    await userEvent.click(screen.getByRole("button", { name: "Talk to Computer" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(consumeCommanderDictation(`${envId}:${threadId}`)).toBe(true);

    // Click Open to side triggers side-open callback without calling onOpen again
    await userEvent.click(screen.getByRole("button", { name: "Open Computer to the side" }));
    expect(onOpenToSide).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
