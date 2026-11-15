import type { PhoneControlReading } from "../../native/phoneControl";

export interface ThisPhoneRow {
  readonly id: string;
  readonly icon:
    | "wifi"
    | "wifi.slash"
    | "slider.horizontal.3"
    | "robot"
    | "pause"
    | "eye"
    | "eye.slash"
    | "clock"
    | "exclamationmark.shield";
  readonly label: string;
  readonly value: string;
}

export type ThisPhoneSummary =
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly headline: string; readonly rows: readonly ThisPhoneRow[] };

function ago(atMillis: number, nowMillis: number): string {
  if (atMillis <= 0) return "Never";
  const seconds = Math.max(0, Math.floor((nowMillis - atMillis) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const MODE_LABELS = {
  unattended: "Unattended",
  manual: "Manual (local arm)",
  off: "Off",
} as const;

/** What the "This phone" page and its Settings row say about the phone-control companion. */
export function summarizeThisPhone(
  reading: PhoneControlReading | null,
  nowMillis: number,
): ThisPhoneSummary {
  if (!reading?.installed) {
    return { kind: "missing", message: "Phone control isn't installed on this phone." };
  }
  if (!reading.reachable || !reading.status) {
    return {
      kind: "refused",
      message:
        "Phone control didn't answer this app. It needs phone-control 0.3 or later, and this app must be the Skofo T3 release build.",
    };
  }
  const status = reading.status;
  const headline = status.paused
    ? "Stopped"
    : status.agentActive
      ? "Claude is using your phone"
      : status.controlMode === "off"
        ? "Off"
        : "Ready";
  const lastKind =
    status.lastRemoteCommandKind === "ui"
      ? " (screen)"
      : status.lastRemoteCommandKind === "background"
        ? " (background)"
        : "";
  return {
    kind: "ready",
    headline,
    rows: [
      {
        id: "hub",
        icon: status.hubConnected ? "wifi" : "wifi.slash",
        label: "Connection",
        value: status.hubConnected ? "Connected to T3" : "Offline",
      },
      {
        id: "mode",
        icon: "slider.horizontal.3",
        label: "Mode",
        value: status.paused
          ? `${MODE_LABELS[status.controlMode]}, stopped`
          : MODE_LABELS[status.controlMode],
      },
      {
        id: "activity",
        icon: status.agentActive ? "robot" : "pause",
        label: "Agent",
        value: status.agentActive ? "Using your phone now" : "Idle",
      },
      {
        id: "viewing",
        icon: status.viewing ? "eye" : "eye.slash",
        label: "Live view",
        value: status.viewing ? "Someone is watching your screen" : "Not being watched",
      },
      {
        id: "last",
        icon: "clock",
        label: "Last remote command",
        value: `${ago(status.lastRemoteCommandAtMillis, nowMillis)}${status.lastRemoteCommandAtMillis > 0 ? lastKind : ""}`,
      },
      {
        id: "takeover",
        icon: "pause",
        label: "You took over",
        value: ago(status.ownerTookOverAtMillis, nowMillis),
      },
      {
        id: "accessibility",
        icon: "exclamationmark.shield",
        label: "Accessibility service",
        value: status.accessibilityEnabled ? "On" : "Off",
      },
    ],
  };
}

/** The Settings index value for the row that opens the page. */
export function thisPhoneRowValue(summary: ThisPhoneSummary): string {
  if (summary.kind === "missing") return "Not installed";
  if (summary.kind === "refused") return "Not answering";
  return summary.headline;
}
