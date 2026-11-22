import { ProviderInstanceId, ThreadTag } from "@t3tools/contracts";

const SKOFO_COMMANDER_ENV_FLAG = "T3CODE_SKOFO_COMMANDER";
export const SKOFO_COMMANDER_TAG = ThreadTag.make("skofo:commander");
export const SKOFO_COMMANDER_TITLE = "Computer";
export const SKOFO_COMMANDER_PROJECT_TITLE = "Computer";
export const SKOFO_COMMANDER_WORKSPACE_SUBDIR = "commander";
export const SKOFO_COMMANDER_STORE_FILENAME = "skofo-commander.json";

export const SKOFO_COMMANDER_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("antigravity");
export const SKOFO_COMMANDER_DEFAULT_MODEL = "gemini-4-neon";

export const SKOFO_COMMANDER_TOOL_PREFIX = "skofo_";

/** Conservative reactor defaults: quiet, low-noise, zero feedback loops. */
export const SKOFO_COMMANDER_MAX_WAKES_PER_HOUR = 12;
export const SKOFO_COMMANDER_WAKE_DEBOUNCE_MS = 30_000;
export const SKOFO_COMMANDER_PENDING_REQUEST_GRACE_MS = 2 * 60_000;
export const SKOFO_COMMANDER_PEER_POLL_INTERVAL_MS = 60_000;
export const SKOFO_COMMANDER_ROLLOVER_CHECK_INTERVAL_MS = 15 * 60_000;
export const SKOFO_COMMANDER_ROLLOVER_CONTEXT_RATIO = 0.65;
export const SKOFO_COMMANDER_ROLLOVER_NIGHTLY_MIN_RUNS = 15;
/** BC permanent Pacific time (UTC-7, no DST): quiet hours 23:00–07:30 local. */
export const SKOFO_COMMANDER_TZ_OFFSET_MINUTES = -7 * 60;
export const SKOFO_COMMANDER_QUIET_START_MINUTE = 23 * 60;
export const SKOFO_COMMANDER_QUIET_END_MINUTE = 7 * 60 + 30;
export const SKOFO_COMMANDER_NIGHTLY_ROLLOVER_START_MINUTE = 4 * 60;
export const SKOFO_COMMANDER_NIGHTLY_ROLLOVER_END_MINUTE = 4 * 60 + 30;

export function isSkofoCommanderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SKOFO_COMMANDER_ENV_FLAG]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
