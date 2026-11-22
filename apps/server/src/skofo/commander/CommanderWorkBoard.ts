import { EnvironmentId, NonNegativeInt, PositiveInt, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const BriefCounts = Schema.Struct({
  active: NonNegativeInt,
  blocked: NonNegativeInt,
  failed: NonNegativeInt,
  working: NonNegativeInt,
  watched: NonNegativeInt,
  completed: NonNegativeInt,
  openPrs: NonNegativeInt,
});

const BriefRow = Schema.Struct({
  environmentId: EnvironmentId,
  machine: Schema.String,
  threadId: ThreadId,
  title: Schema.String,
  link: Schema.String,
  status: Schema.String,
  updatedAt: Schema.String,
  pendingKind: Schema.optional(Schema.String),
  watched: Schema.Boolean,
  openPrCount: NonNegativeInt,
  primaryPr: Schema.optional(Schema.Struct({ number: PositiveInt, url: Schema.String })),
  latestActivity: Schema.NullOr(Schema.String),
});

export const BriefWorkBoard = Schema.Struct({
  view: Schema.Literal("brief"),
  asOf: Schema.String,
  peerDiscovery: Schema.Literals(["available", "unavailable"]),
  machines: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      status: Schema.Literals(["reachable", "unreachable", "expired"]),
      freshAt: Schema.NullOr(Schema.String),
      totals: Schema.NullOr(BriefCounts),
    }),
  ),
  totals: BriefCounts,
  omittedCount: NonNegativeInt,
  omittedMachineCount: NonNegativeInt,
  rows: Schema.Array(BriefRow),
});

type Counts = typeof BriefCounts.Type;
type Row = typeof BriefRow.Type;

interface Machine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: (typeof BriefWorkBoard.Type)["machines"][number]["status"];
  readonly freshAt: string | null;
  readonly rows: ReadonlyArray<Row>;
}

const WORKING_STATUSES = new Set(["preparing", "starting", "running", "waiting", "queued"]);

function priority(row: Row) {
  if (row.pendingKind) return 3;
  if (row.status === "failed") return 2;
  if (WORKING_STATUSES.has(row.status) || row.watched) return 1;
  return 0;
}

function counts(rows: ReadonlyArray<Row>): Counts {
  return {
    active: rows.length,
    blocked: rows.filter((row) => row.pendingKind !== undefined).length,
    failed: rows.filter((row) => row.status === "failed").length,
    working: rows.filter((row) => WORKING_STATUSES.has(row.status)).length,
    watched: rows.filter((row) => row.watched).length,
    completed: rows.filter((row) => row.status === "completed").length,
    openPrs: rows.reduce((total, row) => total + row.openPrCount, 0),
  };
}

export function selectBriefWorkBoard(input: {
  readonly asOf: string;
  readonly machines: ReadonlyArray<Machine>;
  readonly includeIdle: boolean;
  readonly peerDiscovery: "available" | "unavailable";
}): typeof BriefWorkBoard.Type {
  const allRows = input.machines.flatMap((machine) => machine.rows);
  const eligible = allRows.filter((row) => input.includeIdle || priority(row) > 0);
  const sorted = eligible.toSorted(
    (left, right) =>
      priority(right) - priority(left) || right.updatedAt.localeCompare(left.updatedAt),
  );
  let recent = 0;
  const rows = sorted
    .filter((row) => priority(row) > 0 || (row.status === "completed" && recent++ < 4))
    .slice(0, 12);
  return {
    view: "brief",
    asOf: input.asOf,
    peerDiscovery: input.peerDiscovery,
    machines: input.machines.map(({ rows: machineRows, ...machine }) => ({
      ...machine,
      totals: machine.status === "reachable" ? counts(machineRows) : null,
    })),
    totals: counts(allRows),
    omittedCount: eligible.length - rows.length,
    omittedMachineCount: 0,
    rows,
  };
}

export function boundBriefWorkBoard(board: typeof BriefWorkBoard.Type): typeof BriefWorkBoard.Type {
  const rows = [...board.rows];
  const machines = [...board.machines];
  const result = () => ({
    ...board,
    rows,
    machines,
    omittedCount: board.omittedCount + board.rows.length - rows.length,
    omittedMachineCount: board.machines.length - machines.length,
  });
  while (new TextEncoder().encode(JSON.stringify(result())).byteLength > 12_000) {
    if (rows.length > 0) rows.pop();
    else if (machines.length > 0) machines.pop();
    else break;
  }
  return result();
}
