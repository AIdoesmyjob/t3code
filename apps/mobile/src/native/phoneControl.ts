import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";

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
  /** It answered: it is the owner-signed companion and it accepts this app's signature. */
  readonly reachable: boolean;
  readonly status?: PhoneControlStatus;
}

interface Subscription {
  remove(): void;
}

interface T3PhoneControlModule {
  takeAssistRequest(): { readonly text: string; readonly atMillis: number } | null;
  isDefaultAssistant(): Promise<boolean>;
  openAssistantSettings(): boolean;
  moveToBackground(): boolean;
  status(): Promise<PhoneControlReading>;
  pause(): Promise<PhoneControlReading>;
  openCompanion(): boolean;
  addListener(event: "onAssist" | "onStatusChange", listener: () => void): Subscription;
}

/** Android skofo builds only; null elsewhere, including the store variants. */
export const phoneControlNative =
  Constants.expoConfig?.extra?.appVariant === "skofo"
    ? requireOptionalNativeModule<T3PhoneControlModule>("T3PhoneControl")
    : null;
