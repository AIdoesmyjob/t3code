import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import {
  SKOFO_COMMANDER_MAX_WAKES_PER_HOUR,
  SKOFO_COMMANDER_NIGHTLY_ROLLOVER_END_MINUTE,
  SKOFO_COMMANDER_NIGHTLY_ROLLOVER_START_MINUTE,
  SKOFO_COMMANDER_QUIET_END_MINUTE,
  SKOFO_COMMANDER_QUIET_START_MINUTE,
  SKOFO_COMMANDER_ROLLOVER_CONTEXT_RATIO,
  SKOFO_COMMANDER_ROLLOVER_NIGHTLY_MIN_RUNS,
  SKOFO_COMMANDER_STORE_FILENAME,
  SKOFO_COMMANDER_TZ_OFFSET_MINUTES,
} from "./constants.ts";

export const CommanderWatchUntil = Schema.Literals(["turn_end", "settled", "manual"]);
export type CommanderWatchUntil = typeof CommanderWatchUntil.Type;

export const CommanderWatch = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  title: Schema.optional(Schema.String),
  until: CommanderWatchUntil,
  note: Schema.optional(Schema.String),
  createdAt: Schema.String,
  lastSeenStatus: Schema.optional(Schema.String),
  lastSeenRunId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CommanderWatch = typeof CommanderWatch.Type;

export const CommanderPersistedState = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  watches: Schema.Array(CommanderWatch),
  wakeTimestampsMs: Schema.Array(Schema.Number),
  lastRolloverAt: Schema.NullOr(Schema.String),
  rolloverRunBaseline: Schema.Number,
  pendingFreshContext: Schema.Boolean,
});
export type CommanderPersistedState = typeof CommanderPersistedState.Type;

const EMPTY_COMMANDER_STATE: CommanderPersistedState = {
  version: 1,
  projectId: null,
  threadId: null,
  watches: [],
  wakeTimestampsMs: [],
  lastRolloverAt: null,
  rolloverRunBaseline: 0,
  pendingFreshContext: false,
};

export function watchKey(watch: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly threadId: ThreadId;
}): string {
  return `${watch.environmentId ?? "local"}:${watch.threadId}`;
}

export function upsertWatch(
  watches: ReadonlyArray<CommanderWatch>,
  next: CommanderWatch,
): ReadonlyArray<CommanderWatch> {
  const key = watchKey(next);
  const filtered = watches.filter((item) => watchKey(item) !== key);
  return [...filtered, next];
}

export function removeWatch(
  watches: ReadonlyArray<CommanderWatch>,
  target: { readonly environmentId?: EnvironmentId | undefined; readonly threadId: ThreadId },
): { readonly watches: ReadonlyArray<CommanderWatch>; readonly removed: boolean } {
  const key = watchKey(target);
  const next = watches.filter((item) => watchKey(item) !== key);
  return { watches: next, removed: next.length !== watches.length };
}

export function pruneWakeTimestamps(
  timestampsMs: ReadonlyArray<number>,
  nowMs: number,
  windowMs = 60 * 60_000,
): ReadonlyArray<number> {
  const cutoff = nowMs - windowMs;
  return timestampsMs.filter((ts) => Number.isFinite(ts) && ts >= cutoff && ts <= nowMs + 60_000);
}

const MS_PER_DAY = 24 * 60 * 60_000;

function localMinuteOfDay(
  nowMs: number,
  tzOffsetMinutes = SKOFO_COMMANDER_TZ_OFFSET_MINUTES,
): number {
  const shiftedMs = nowMs + tzOffsetMinutes * 60_000;
  const msInDay = ((shiftedMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return Math.floor(msInDay / 60_000);
}

function isWithinQuietHours(
  nowMs: number,
  options?: {
    readonly tzOffsetMinutes?: number;
    readonly quietStartMinute?: number;
    readonly quietEndMinute?: number;
  },
): boolean {
  const minute = localMinuteOfDay(nowMs, options?.tzOffsetMinutes);
  const start = options?.quietStartMinute ?? SKOFO_COMMANDER_QUIET_START_MINUTE;
  const end = options?.quietEndMinute ?? SKOFO_COMMANDER_QUIET_END_MINUTE;
  return start > end ? minute >= start || minute < end : minute >= start && minute < end;
}

export function canAutoWake(input: {
  readonly wakeTimestampsMs: ReadonlyArray<number>;
  readonly nowMs: number;
  readonly urgent: boolean;
  readonly maxPerHour?: number;
}): { readonly allowed: boolean; readonly reason?: string } {
  if (!input.urgent && isWithinQuietHours(input.nowMs)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  const recent = pruneWakeTimestamps(input.wakeTimestampsMs, input.nowMs);
  const cap = input.maxPerHour ?? SKOFO_COMMANDER_MAX_WAKES_PER_HOUR;
  if (recent.length >= cap) {
    return { allowed: false, reason: "hourly_cap" };
  }
  return { allowed: true };
}

export function shouldTriggerContextRollover(input: {
  readonly nowMs: number;
  readonly isIdle: boolean;
  readonly pendingFreshContext: boolean;
  readonly contextTokensUsed: number | null;
  readonly contextWindowTokens: number | null;
  readonly completedRunsSinceRollover: number;
  readonly lastRolloverAt: string | null;
}): { readonly shouldRollover: boolean; readonly reason?: "context_ratio" | "nightly_idle" } {
  if (!input.isIdle || input.pendingFreshContext) return { shouldRollover: false };
  const lastMs = input.lastRolloverAt ? Date.parse(input.lastRolloverAt) : Number.NaN;
  if (Number.isFinite(lastMs) && input.nowMs - lastMs < 60 * 60_000) {
    return { shouldRollover: false };
  }
  if (
    input.contextTokensUsed !== null &&
    input.contextWindowTokens !== null &&
    input.contextWindowTokens > 0 &&
    input.contextTokensUsed / input.contextWindowTokens >= SKOFO_COMMANDER_ROLLOVER_CONTEXT_RATIO
  ) {
    return { shouldRollover: true, reason: "context_ratio" };
  }
  const minute = localMinuteOfDay(input.nowMs);
  const inNightlyWindow =
    minute >= SKOFO_COMMANDER_NIGHTLY_ROLLOVER_START_MINUTE &&
    minute < SKOFO_COMMANDER_NIGHTLY_ROLLOVER_END_MINUTE;
  if (
    inNightlyWindow &&
    input.completedRunsSinceRollover >= SKOFO_COMMANDER_ROLLOVER_NIGHTLY_MIN_RUNS
  ) {
    if (!Number.isFinite(lastMs) || input.nowMs - lastMs >= 12 * 60 * 60_000) {
      return { shouldRollover: true, reason: "nightly_idle" };
    }
  }
  return { shouldRollover: false };
}

const PersistedStateJson = Schema.fromJsonString(CommanderPersistedState);
const decodePersistedStateJson = Schema.decodeUnknownSync(PersistedStateJson);
const encodePersistedStateJson = Schema.encodeEffect(PersistedStateJson);

function parseCommanderStateJson(raw: string): CommanderPersistedState {
  try {
    return decodePersistedStateJson(raw);
  } catch {
    return EMPTY_COMMANDER_STATE;
  }
}

export interface CommanderStoreShape {
  readonly storePath: string;
  readonly get: Effect.Effect<CommanderPersistedState>;
  readonly update: (
    fn: (current: CommanderPersistedState) => CommanderPersistedState,
  ) => Effect.Effect<CommanderPersistedState>;
}

export class CommanderStore extends Context.Service<CommanderStore, CommanderStoreShape>()(
  "t3/skofo/commander/CommanderStore",
) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storePath = path.join(config.stateDir, SKOFO_COMMANDER_STORE_FILENAME);

  const initial = yield* fs.readFileString(storePath).pipe(
    Effect.map(parseCommanderStateJson),
    Effect.orElseSucceed(() => EMPTY_COMMANDER_STATE),
  );
  const stateRef = yield* Ref.make(initial);

  const persist = Effect.fn("CommanderStore.persist")(function* (next: CommanderPersistedState) {
    const nowMs = yield* Clock.currentTimeMillis;
    const tmpPath = `${storePath}.tmp.${process.pid}.${nowMs}`;
    yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.ignore);
    yield* encodePersistedStateJson(next).pipe(
      Effect.flatMap((serialized) => fs.writeFileString(tmpPath, `${serialized}\n`)),
      Effect.andThen(fs.rename(tmpPath, storePath)),
      Effect.catch((cause) =>
        fs
          .remove(tmpPath)
          .pipe(
            Effect.ignore,
            Effect.andThen(Effect.logWarning("Failed to persist skofo-commander state", { cause })),
          ),
      ),
    );
  });

  const get = Ref.get(stateRef);
  const update = Effect.fn("CommanderStore.update")(function* (
    fn: (current: CommanderPersistedState) => CommanderPersistedState,
  ) {
    const next = yield* Ref.updateAndGet(stateRef, fn);
    yield* persist(next);
    return next;
  });

  return CommanderStore.of({ storePath, get, update });
});

export const layer = Layer.effect(CommanderStore, make);
