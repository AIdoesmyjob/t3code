/** Allow time to deliver an overlay failure before the broker times out. */
export const PREVIEW_HOST_RESPONSE_MARGIN_MS = 1_500;

const HOST_RESPONSE_MARGIN_FRACTION = 0.2;

export function resolveHostWaitBudgetMs(requestTimeoutMs: number): number {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return 0;
  }
  const reservedMs = Math.min(
    PREVIEW_HOST_RESPONSE_MARGIN_MS,
    Math.ceil(requestTimeoutMs * HOST_RESPONSE_MARGIN_FRACTION),
  );
  return Math.max(0, requestTimeoutMs - reservedMs);
}
