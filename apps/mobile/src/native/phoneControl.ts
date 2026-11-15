import { requireOptionalNativeModule } from "expo";

export type PhoneControlMode = "unattended" | "manual" | "off";

/** The phone-control companion's status (its provider contract); never screen content. */
export interface PhoneControlStatus {
  readonly companionVersion: string;
  readonly hubConnected: boolean;
  readonly controlMode: PhoneControlMode;
  readonly paused: boolean;
  readonly agentActive: boolean;
  readonly viewing: boolean;
  readonly ownerTookOverAtMillis: number;
  readonly lastRemoteCommandAtMillis: number;
  readonly lastRemoteCommandKind: "ui" | "background" | "none";
  readonly accessibilityEnabled: boolean;
}

export interface PhoneControlReading {
  /** The genuine companion owns the status provider. */
  readonly installed: boolean;
  /** It answered this app (it refuses apps without the Skofo T3 signature). */
  readonly reachable: boolean;
  readonly status?: PhoneControlStatus;
}

interface Subscription {
  remove(): void;
}

interface T3PhoneControlModule {
  takeAssistRequest(): { readonly text: string; readonly atMillis: number } | null;
  isDefaultAssistant(): boolean;
  openAssistantSettings(): boolean;
  moveToBackground(): boolean;
  status(): PhoneControlReading;
  pause(): PhoneControlReading;
  openCompanion(): boolean;
  addListener(event: "onAssist" | "onStatusChange", listener: () => void): Subscription;
}

/** Android skofo builds only; null elsewhere. */
export const phoneControlNative =
  requireOptionalNativeModule<T3PhoneControlModule>("T3PhoneControl");
