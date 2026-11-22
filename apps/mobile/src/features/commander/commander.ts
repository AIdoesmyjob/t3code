import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";

export const SKOFO_COMMANDER_TAG = "skofo:commander";

export interface MobileCommanderThreadLike {
  readonly source?: {
    readonly tags?: ReadonlyArray<string> | undefined;
  } | null;
}

export function isCommanderThread(thread: MobileCommanderThreadLike | null | undefined): boolean {
  return thread?.source?.tags?.includes(SKOFO_COMMANDER_TAG) === true;
}

export function findCommanderThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (thread) =>
      thread.archivedAt === null && thread.deletedAt === null && isCommanderThread(thread),
  );
}

export interface MobileCommanderStats {
  readonly active: number;
  readonly working: number;
  readonly blocked: number;
  readonly failed: number;
}

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function computeMobileCommanderStats(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  commanderThreadKey: string | null,
): MobileCommanderStats {
  let active = 0;
  let working = 0;
  let blocked = 0;
  let failed = 0;
  for (const thread of threads) {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (
      key === commanderThreadKey ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      !isListedThreadLineage(thread.lineage) ||
      isCommanderThread(thread)
    ) {
      continue;
    }
    active += 1;
    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingSubagentRequest != null
    ) {
      blocked += 1;
    }
    const status = thread.runtime?.status ?? null;
    if (status === "failed") {
      failed += 1;
    } else if (status !== null && WORKING_STATUSES.has(status)) {
      working += 1;
    }
  }
  return { active, working, blocked, failed };
}

export function isMobileCommanderWorking(thread: EnvironmentThreadShell): boolean {
  const status = thread.runtime?.status ?? null;
  return status !== null && WORKING_STATUSES.has(status);
}

const DICTATION_REQUEST_TTL_MS = 10_000;

interface PendingMobileDictation {
  readonly threadKey: string;
  readonly expiresAt: number;
}

let pendingMobileDictation: PendingMobileDictation | null = null;
const mobileDictationListeners = new Set<(threadKey: string) => void>();

export function requestMobileCommanderDictation(threadKey: string, nowMs = Date.now()): void {
  pendingMobileDictation = { threadKey, expiresAt: nowMs + DICTATION_REQUEST_TTL_MS };
  for (const listener of mobileDictationListeners) {
    listener(threadKey);
  }
}

export function consumeMobileCommanderDictation(threadKey: string, nowMs = Date.now()): boolean {
  if (pendingMobileDictation === null) return false;
  if (pendingMobileDictation.expiresAt < nowMs) {
    pendingMobileDictation = null;
    return false;
  }
  if (pendingMobileDictation.threadKey !== threadKey) return false;
  pendingMobileDictation = null;
  return true;
}

export function subscribeMobileCommanderDictation(
  listener: (threadKey: string) => void,
): () => void {
  mobileDictationListeners.add(listener);
  return () => {
    mobileDictationListeners.delete(listener);
  };
}
