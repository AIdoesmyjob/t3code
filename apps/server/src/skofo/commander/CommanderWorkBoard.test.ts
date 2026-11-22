import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { boundBriefWorkBoard, selectBriefWorkBoard } from "./CommanderWorkBoard.ts";

const localId = EnvironmentId.make("local");
const peerId = EnvironmentId.make("peer");
const offlineId = EnvironmentId.make("offline");
const asOf = "2026-11-22T14:00:00.000Z";

function row(title: string, status: string, overrides?: Partial<ReturnType<typeof rowInput>>) {
  return { ...rowInput(title, status), ...overrides };
}

function rowInput(title: string, status: string) {
  return {
    environmentId: localId,
    machine: "local",
    threadId: ThreadId.make(title),
    title,
    link: `[${title}](t3-thread://v2/local/${title})`,
    status,
    updatedAt: asOf,
    watched: false,
    openPrCount: 0,
    latestActivity: null as string | null,
    pendingKind: undefined as string | undefined,
  };
}

describe("brief Commander work board", () => {
  it("ranks rows across machines, caps completions and keeps full totals", () => {
    const localRows = [
      ...Array.from({ length: 8 }, (_, i) => row(`recent-${i}`, "completed")),
      row("watch", "idle", { watched: true }),
      row("running", "running", { openPrCount: 2 }),
    ];
    const peerRows = [
      row("failed", "failed", { environmentId: peerId }),
      row("approval", "waiting", { environmentId: peerId, pendingKind: "permission" }),
    ];
    const board = selectBriefWorkBoard({
      asOf,
      peerDiscovery: "available",
      includeIdle: true,
      machines: [
        {
          environmentId: localId,
          label: "local",
          status: "reachable",
          freshAt: asOf,
          rows: localRows,
        },
        {
          environmentId: peerId,
          label: "peer",
          status: "reachable",
          freshAt: asOf,
          rows: peerRows,
        },
        {
          environmentId: offlineId,
          label: "offline",
          status: "unreachable",
          freshAt: null,
          rows: [],
        },
      ],
    });
    expect(board.rows.slice(0, 4).map(({ title }) => title)).toEqual([
      "approval",
      "failed",
      "watch",
      "running",
    ]);
    expect(board.rows.filter((entry) => entry.status === "completed")).toHaveLength(4);
    expect(board.totals).toEqual({
      active: 12,
      blocked: 1,
      failed: 1,
      working: 2,
      watched: 1,
      completed: 8,
      openPrs: 2,
    });
    expect(board.omittedCount).toBe(4);
    expect(board.machines[2]).toMatchObject({ status: "unreachable", totals: null, freshAt: null });
  });

  it("enforces the global row and UTF-8 byte limits without shortening thread links", () => {
    const rows = [
      row("critical", "failed"),
      ...Array.from({ length: 20 }, (_, i) =>
        row(`run-${i}`, "running", { title: "星".repeat(1_000), latestActivity: "🚀".repeat(160) }),
      ),
    ];
    const board = selectBriefWorkBoard({
      asOf,
      peerDiscovery: "available",
      includeIdle: true,
      machines: [
        { environmentId: localId, label: "local", status: "reachable", freshAt: asOf, rows },
      ],
    });
    expect(board.rows).toHaveLength(12);
    const bounded = boundBriefWorkBoard(board);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
      12_000,
    );
    expect(bounded.rows[0]?.link).toBe(rows[0]?.link);
    expect(bounded.omittedCount + bounded.rows.length).toBe(rows.length);
    expect(bounded.totals.active).toBe(rows.length);
  });
});
