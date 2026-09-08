import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  resolveHostWaitBudgetMs,
} from "./previewAutomationHostBudget";

describe("resolveHostWaitBudgetMs", () => {
  it("reserves the full response margin once the request budget allows it", () => {
    expect(resolveHostWaitBudgetMs(15_000)).toBe(15_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
    expect(resolveHostWaitBudgetMs(60_000)).toBe(60_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("keeps most of a short request budget instead of collapsing it", () => {
    expect(resolveHostWaitBudgetMs(1_000)).toBe(800);
    expect(resolveHostWaitBudgetMs(100)).toBe(80);
  });

  it("returns a non-negative budget for invalid input", () => {
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveHostWaitBudgetMs(invalid)).toBeGreaterThanOrEqual(0);
    }
  });
});
