import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isListedThreadLineage } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";

export const SKOFO_COMMANDER_TAG = "skofo:commander";

export interface CommanderThreadLike {
  readonly source?: {
    readonly tags?: ReadonlyArray<string> | undefined;
  } | null;
}

export function isCommanderThread(thread: CommanderThreadLike | null | undefined): boolean {
  return thread?.source?.tags?.includes(SKOFO_COMMANDER_TAG) === true;
}

export function findCommanderThread<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "deletedAt"> & CommanderThreadLike,
>(threads: ReadonlyArray<T>): T | undefined {
  return threads.find(
    (thread) =>
      thread.archivedAt === null && thread.deletedAt === null && isCommanderThread(thread),
  );
}

export interface CommanderSidebarStats {
  readonly active: number;
  readonly working: number;
  readonly blocked: number;
  readonly failed: number;
}

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function computeCommanderSidebarStats(
  threads: ReadonlyArray<SidebarThreadSummary>,
  commanderThreadKey: string | null,
): CommanderSidebarStats {
  let active = 0;
  let working = 0;
  let blocked = 0;
  let failed = 0;
  for (const thread of threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
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
    const hasBlocked =
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.pendingSubagentRequest != null;
    if (hasBlocked) blocked += 1;
    const status = thread.runtime?.status ?? null;
    if (status === "failed") {
      failed += 1;
    } else if (status !== null && WORKING_STATUSES.has(status)) {
      working += 1;
    }
  }
  return { active, working, blocked, failed };
}

export function isCommanderThreadWorking(thread: Pick<SidebarThreadSummary, "runtime">): boolean {
  const status = thread.runtime?.status ?? null;
  return status !== null && WORKING_STATUSES.has(status);
}

export function commanderHasUnreadCompletion(
  thread: Pick<SidebarThreadSummary, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const status = thread.latestRun?.status;
  if (status === "interrupted" || status === "cancelled") return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return true;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

const DICTATION_REQUEST_TTL_MS = 10_000;

interface PendingDictationRequest {
  readonly threadKey: string;
  readonly expiresAt: number;
}

let pendingDictationRequest: PendingDictationRequest | null = null;
const dictationListeners = new Set<(threadKey: string) => void>();

export function requestCommanderDictation(threadKey: string, nowMs = Date.now()): void {
  pendingDictationRequest = { threadKey, expiresAt: nowMs + DICTATION_REQUEST_TTL_MS };
  for (const listener of dictationListeners) {
    listener(threadKey);
  }
}

export function consumeCommanderDictation(threadKey: string, nowMs = Date.now()): boolean {
  if (pendingDictationRequest === null) return false;
  if (pendingDictationRequest.expiresAt < nowMs) {
    pendingDictationRequest = null;
    return false;
  }
  if (pendingDictationRequest.threadKey !== threadKey) return false;
  pendingDictationRequest = null;
  return true;
}

export function subscribeCommanderDictation(listener: (threadKey: string) => void): () => void {
  dictationListeners.add(listener);
  return () => {
    dictationListeners.delete(listener);
  };
}
