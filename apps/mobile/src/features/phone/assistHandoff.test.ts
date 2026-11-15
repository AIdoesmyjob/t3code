import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../native/phoneControl", () => ({ phoneControlNative: null }));
vi.mock("../sharing/IncomingShareProvider", () => ({ addIncomingTextDraft: vi.fn() }));
vi.mock("../../lib/appState", () => ({ subscribeAppActive: () => () => {} }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "uuid" }));

import { assistDraftText, installAssistHandoff, isAssistShareId } from "./assistHandoff";

describe("assistHandoff", () => {
  it("leads a spoken request with the phone", () => {
    expect(assistDraftText("  turn on wifi ")).toBe("On my phone: turn on wifi");
    expect(assistDraftText("")).toBe("On my phone: ");
  });

  it("recognizes only its own draft ids", () => {
    expect(isAssistShareId("assist-1234")).toBe(true);
    expect(isAssistShareId("share-abc")).toBe(false);
    expect(isAssistShareId(undefined)).toBe(false);
  });

  it("does nothing without the native module", () => {
    expect(() => installAssistHandoff()()).not.toThrow();
  });
});
