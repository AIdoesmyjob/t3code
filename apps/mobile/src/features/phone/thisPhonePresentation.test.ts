import { describe, expect, it } from "vite-plus/test";

import type { PhoneControlStatus } from "../../native/phoneControl";
import { summarizeThisPhone, thisPhoneRowValue } from "./thisPhonePresentation";

const NOW = 1_800_000_000_000;

function status(overrides: Partial<PhoneControlStatus> = {}): PhoneControlStatus {
  return {
    companionVersion: "0.3.0",
    hubConnected: true,
    controlMode: "unattended",
    paused: false,
    agentActive: false,
    viewing: false,
    ownerTookOverAtMillis: 0,
    lastRemoteCommandAtMillis: NOW - 5 * 60_000,
    lastRemoteCommandKind: "ui",
    accessibilityEnabled: true,
    ...overrides,
  };
}

describe("summarizeThisPhone", () => {
  it("says when the companion is missing or refuses this app", () => {
    expect(summarizeThisPhone(null, NOW).kind).toBe("missing");
    expect(summarizeThisPhone({ installed: false, reachable: false }, NOW).kind).toBe("missing");
    const refused = summarizeThisPhone({ installed: true, reachable: false }, NOW);
    expect(refused.kind).toBe("refused");
    expect(thisPhoneRowValue(refused)).toBe("Not answering");
  });

  it("puts a stop ahead of activity", () => {
    const summary = summarizeThisPhone(
      { installed: true, reachable: true, status: status({ paused: true, agentActive: true }) },
      NOW,
    );
    expect(summary.kind === "ready" && summary.headline).toBe("Stopped");
  });

  it("describes activity, viewing and the last command", () => {
    const summary = summarizeThisPhone(
      {
        installed: true,
        reachable: true,
        status: status({ agentActive: true, viewing: true, ownerTookOverAtMillis: NOW - 30_000 }),
      },
      NOW,
    );
    if (summary.kind !== "ready") throw new Error("expected a ready summary");
    expect(summary.headline).toBe("Claude is using your phone");
    const value = (id: string) => summary.rows.find((row) => row.id === id)?.value;
    expect(value("viewing")).toBe("Someone is watching your screen");
    expect(value("last")).toBe("5 min ago (screen)");
    expect(value("takeover")).toBe("Just now");
    expect(value("hub")).toBe("Connected to T3");
  });

  it("shows never for zero timestamps", () => {
    const summary = summarizeThisPhone(
      { installed: true, reachable: true, status: status({ lastRemoteCommandAtMillis: 0 }) },
      NOW,
    );
    if (summary.kind !== "ready") throw new Error("expected a ready summary");
    expect(summary.rows.find((row) => row.id === "last")?.value).toBe("Never");
  });
});
