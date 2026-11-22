import { useSyncExternalStore } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { transcribeEnvironmentAudio } from "@t3tools/client-runtime/voice-input";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type AudioRecorder,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Platform } from "react-native";

import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";

type AudioSessionToken = ReturnType<typeof acquireAudioSession>;
import { mobileCommanderSpeech, type MobileCommanderSpeakOutcome } from "./mobileCommanderSpeech";

export type MobileVoiceChatPhase =
  | "off"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused"
  | "error";

export type MobileVoiceChatHintCode =
  | "requesting-mic"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused"
  | "paused-silence"
  | "missed"
  | "send-failed";

export type MobileVoiceChatErrorCode = "permission-denied" | "mic-error" | "transcribe-failed";

export interface MobileCommanderVoiceChatState {
  readonly activeThreadKey: string | null;
  readonly phase: MobileVoiceChatPhase;
  readonly level: number;
  readonly heardSpeech: boolean;
  readonly lastTranscript: string | null;
  readonly hintCode: MobileVoiceChatHintCode | null;
  readonly errorCode: MobileVoiceChatErrorCode | null;
  readonly errorDetail: string | null;
}

export interface MobileCommanderVoiceChatHost {
  readonly prepared: PreparedConnection;
  readonly sendMessage: (text: string) => Promise<boolean>;
}

const VAD_POLL_MS = 100;
const NOISE_CALIBRATION_MS = 400;
const SPEECH_ONSET_MIN_MS = 200;
const SILENCE_END_MS = 1_400;
const MAX_UTTERANCE_MS = 45_000;
const IDLE_LISTEN_TIMEOUT_MS = 22_000;
const POST_SPEECH_RESUME_MS = 450;
const KEEP_AWAKE_TAG = "skofo-commander-voice-chat";

function buildRecordingOptions() {
  const { ios, android } = RecordingPresets.HIGH_QUALITY;
  return {
    extension: RecordingPresets.HIGH_QUALITY.extension,
    sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
    numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
    bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
    isMeteringEnabled: true,
    ...(Platform.OS === "ios" ? ios : android),
  };
}

class MobileCommanderVoiceChatController {
  private state: MobileCommanderVoiceChatState = {
    activeThreadKey: null,
    phase: "off",
    level: 0,
    heardSpeech: false,
    lastTranscript: null,
    hintCode: null,
    errorCode: null,
    errorDetail: null,
  };
  private listeners = new Set<() => void>();
  private hosts = new Map<string, MobileCommanderVoiceChatHost>();
  private generation = 0;
  private recorder: AudioRecorder | null = null;
  private recordingSession: AudioSessionToken | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private keepAwakeActive = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MobileCommanderVoiceChatState => this.state;

  private emit(patch: Partial<MobileCommanderVoiceChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  registerHost(threadKey: string, host: MobileCommanderVoiceChatHost): () => void {
    this.hosts.set(threadKey, host);
    return () => {
      if (this.hosts.get(threadKey) === host) {
        this.hosts.delete(threadKey);
      }
      if (this.state.activeThreadKey === threadKey) {
        this.stop();
      }
    };
  }

  isActiveFor(threadKey: string | null): boolean {
    return (
      threadKey !== null && this.state.activeThreadKey === threadKey && this.state.phase !== "off"
    );
  }

  private clearTimers() {
    if (this.vadTimer !== null) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private setKeepAwake(enabled: boolean) {
    if (enabled === this.keepAwakeActive) return;
    this.keepAwakeActive = enabled;
    if (enabled) {
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
  }

  private async releaseRecordingResources(deleteUri?: string | null) {
    this.clearTimers();
    const rec = this.recorder;
    this.recorder = null;
    let uri: string | null = deleteUri ?? null;
    if (rec) {
      try {
        if (rec.isRecording) {
          await rec.stop();
        }
        uri = uri ?? rec.uri ?? null;
      } catch {
        // Ignore teardown stop error.
      }
      try {
        rec.release();
      } catch {
        // Ignore release error.
      }
    }
    if (this.recordingSession) {
      const token = this.recordingSession;
      this.recordingSession = null;
      await releaseAudioSession(token).catch(() => {});
    }
    if (uri) {
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch {
        // Ignore temp file cleanup error.
      }
    }
  }

  stop() {
    this.generation += 1;
    this.clearTimers();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    void this.releaseRecordingResources();
    mobileCommanderSpeech.stop();
    this.setKeepAwake(false);
    if (this.state.phase !== "off" || this.state.activeThreadKey !== null) {
      this.emit({
        activeThreadKey: null,
        phase: "off",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: null,
        errorDetail: null,
      });
    }
  }

  async toggleForThread(threadKey: string): Promise<void> {
    if (this.isActiveFor(threadKey)) {
      this.stop();
      return;
    }
    await this.startForThread(threadKey);
  }

  async startForThread(threadKey: string): Promise<void> {
    const host = this.hosts.get(threadKey);
    if (!host) return;

    this.generation += 1;
    const myGen = this.generation;
    this.clearTimers();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    await this.releaseRecordingResources();
    mobileCommanderSpeech.stop();
    mobileCommanderSpeech.setTalkBackEnabled(true);
    this.setKeepAwake(true);

    this.emit({
      activeThreadKey: threadKey,
      phase: "starting",
      level: 0,
      heardSpeech: false,
      hintCode: "requesting-mic",
      errorCode: null,
      errorDetail: null,
    });

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (this.generation !== myGen) return;
      if (!permission.granted) {
        this.setKeepAwake(false);
        this.emit({
          activeThreadKey: threadKey,
          phase: "error",
          level: 0,
          heardSpeech: false,
          hintCode: null,
          errorCode: "permission-denied",
          errorDetail: null,
        });
        return;
      }

      await mobileCommanderSpeech.playBeep(host.prepared, "listen");
      if (this.generation !== myGen) return;
      await this.beginListeningTurn(threadKey, myGen);
    } catch (err) {
      if (this.generation !== myGen) return;
      this.setKeepAwake(false);
      this.emit({
        activeThreadKey: threadKey,
        phase: "error",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: "mic-error",
        errorDetail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async beginListeningTurn(threadKey: string, sessionGen: number): Promise<void> {
    if (this.generation !== sessionGen) return;
    const host = this.hosts.get(threadKey);
    if (!host) {
      this.stop();
      return;
    }

    await this.releaseRecordingResources();
    if (this.generation !== sessionGen) return;

    const session = acquireAudioSession("recording", () => {
      if (this.generation === sessionGen) {
        this.stop();
      }
    });
    this.recordingSession = session;

    try {
      const activated = await activateAudioSession(session);
      if (!activated || this.generation !== sessionGen) {
        await this.releaseRecordingResources();
        return;
      }

      const recorder = new AudioModule.AudioRecorder(buildRecordingOptions());
      this.recorder = recorder;
      await recorder.prepareToRecordAsync();
      if (this.generation !== sessionGen) {
        await this.releaseRecordingResources();
        return;
      }
      recorder.record();

      this.emit({
        activeThreadKey: threadKey,
        phase: "listening",
        level: 0,
        heardSpeech: false,
        hintCode: "listening",
        errorCode: null,
        errorDetail: null,
      });

      const startedAt = Date.now();
      let noiseSamples = 0;
      let noiseSumDb = 0;
      let noiseFloorDb = -48;
      let speechMs = 0;
      let heardSpeech = false;
      let silenceMs = 0;

      this.vadTimer = setInterval(() => {
        if (this.generation !== sessionGen || this.state.phase !== "listening" || !this.recorder) {
          this.clearTimers();
          return;
        }
        const elapsed = Date.now() - startedAt;
        const status = this.recorder.getStatus();
        const metering =
          typeof status?.metering === "number" && Number.isFinite(status.metering)
            ? status.metering
            : null;

        if (metering !== null) {
          if (elapsed <= NOISE_CALIBRATION_MS) {
            noiseSumDb += metering;
            noiseSamples += 1;
            noiseFloorDb = Math.max(-55, Math.min(-28, noiseSumDb / Math.max(1, noiseSamples)));
          }
          const onsetDb = Math.max(-34, noiseFloorDb + 10);
          const releaseDb = Math.max(-38, noiseFloorDb + 6);
          const visualLevel = Math.max(0, Math.min(1, (metering + 55) / 45));

          if (metering >= onsetDb) {
            speechMs += VAD_POLL_MS;
            silenceMs = 0;
            if (!heardSpeech && speechMs >= SPEECH_ONSET_MIN_MS) {
              heardSpeech = true;
              this.emit({
                level: visualLevel,
                heardSpeech: true,
                hintCode: "hearing",
              });
              return;
            }
          } else if (heardSpeech && metering < releaseDb) {
            silenceMs += VAD_POLL_MS;
          } else if (!heardSpeech) {
            speechMs = Math.max(0, speechMs - VAD_POLL_MS);
          }

          this.emit({ level: visualLevel });

          if (heardSpeech && (silenceMs >= SILENCE_END_MS || elapsed >= MAX_UTTERANCE_MS)) {
            void this.finishUtterance(threadKey, sessionGen);
            return;
          }
        }

        if (!heardSpeech && elapsed >= IDLE_LISTEN_TIMEOUT_MS) {
          void this.releaseRecordingResources();
          this.emit({
            phase: "paused",
            level: 0,
            heardSpeech: false,
            hintCode: "paused-silence",
          });
        }
      }, VAD_POLL_MS);
    } catch (err) {
      if (this.generation !== sessionGen) return;
      await this.releaseRecordingResources();
      this.emit({
        phase: "error",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: "mic-error",
        errorDetail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sendNow() {
    if (this.state.phase !== "listening" || !this.state.activeThreadKey) return;
    void this.finishUtterance(this.state.activeThreadKey, this.generation);
  }

  private async finishUtterance(threadKey: string, sessionGen: number): Promise<void> {
    if (this.generation !== sessionGen || this.state.phase !== "listening") return;
    const host = this.hosts.get(threadKey);
    const rec = this.recorder;
    if (!host || !rec) return;

    this.clearTimers();
    this.recorder = null;
    this.emit({
      phase: "transcribing",
      level: 0,
      hintCode: "transcribing",
    });

    let recordingUri: string | null = null;
    try {
      if (rec.isRecording) {
        await rec.stop();
      }
      recordingUri = rec.uri ?? null;
    } catch {
      recordingUri = rec.uri ?? null;
    }
    try {
      rec.release();
    } catch {
      // Ignore release error.
    }
    if (this.recordingSession) {
      const token = this.recordingSession;
      this.recordingSession = null;
      await releaseAudioSession(token).catch(() => {});
    }

    if (this.generation !== sessionGen || !recordingUri) {
      if (recordingUri) {
        try {
          new File(recordingUri).delete();
        } catch {
          // Ignore cleanup error.
        }
      }
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    void mobileCommanderSpeech.playBeep(host.prepared, "ack");

    try {
      const file = new File(recordingUri);
      const audioBase64 = await file.base64();
      try {
        if (file.exists) file.delete();
      } catch {
        // Ignore cleanup error.
      }
      if (this.generation !== sessionGen || abort.signal.aborted) return;

      const canSend = () => !abort.signal.aborted && this.generation === sessionGen;
      const result = await runSpeech(
        transcribeEnvironmentAudio(
          host.prepared,
          { audioBase64, mimeType: "audio/mp4", language: "en" },
          canSend,
        ),
        abort.signal,
        canSend,
      );
      if (this.generation !== sessionGen || abort.signal.aborted) return;
      this.abortController = null;

      const transcript = result.text.trim();
      if (!transcript) {
        this.emit({ hintCode: "missed" });
        await this.beginListeningTurn(threadKey, sessionGen);
        return;
      }

      const sent = await host.sendMessage(transcript);
      if (this.generation !== sessionGen) return;
      if (!sent) {
        this.emit({
          phase: "paused",
          lastTranscript: transcript,
          hintCode: "send-failed",
        });
        return;
      }

      this.emit({
        phase: "thinking",
        level: 0,
        heardSpeech: false,
        lastTranscript: transcript,
        hintCode: "thinking",
        errorCode: null,
        errorDetail: null,
      });
    } catch (err) {
      if (this.generation !== sessionGen || abort.signal.aborted) return;
      this.abortController = null;
      this.emit({
        phase: "error",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: "transcribe-failed",
        errorDetail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  togglePause() {
    const threadKey = this.state.activeThreadKey;
    if (!threadKey) return;
    if (this.state.phase === "listening") {
      void this.releaseRecordingResources();
      this.emit({
        phase: "paused",
        level: 0,
        heardSpeech: false,
        hintCode: "paused",
      });
      return;
    }
    if (this.state.phase === "paused" || this.state.phase === "error") {
      const host = this.hosts.get(threadKey);
      if (!host) return;
      const myGen = this.generation;
      void mobileCommanderSpeech.playBeep(host.prepared, "listen").then(() => {
        if (this.generation === myGen) {
          void this.beginListeningTurn(threadKey, myGen);
        }
      });
    }
  }

  interruptAndListen() {
    const threadKey = this.state.activeThreadKey;
    if (!threadKey || this.state.phase === "off") return;
    mobileCommanderSpeech.stop();
    this.clearTimers();
    const host = this.hosts.get(threadKey);
    if (!host) return;
    const myGen = this.generation;
    void mobileCommanderSpeech.playBeep(host.prepared, "listen").then(() => {
      if (this.generation === myGen) {
        void this.beginListeningTurn(threadKey, myGen);
      }
    });
  }

  notifySpeakingStart(threadKey: string) {
    if (!this.isActiveFor(threadKey)) return;
    void this.releaseRecordingResources();
    this.emit({
      phase: "speaking",
      level: 0,
      heardSpeech: false,
      hintCode: "speaking",
      errorCode: null,
      errorDetail: null,
    });
  }

  notifySpeakingFinished(threadKey: string, outcome: MobileCommanderSpeakOutcome) {
    if (!this.isActiveFor(threadKey)) return;
    if (this.state.phase !== "speaking" && this.state.phase !== "thinking") return;
    if (outcome !== "completed") return;
    const host = this.hosts.get(threadKey);
    if (!host) return;
    const myGen = this.generation;
    this.clearTimers();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.generation !== myGen || !this.isActiveFor(threadKey)) return;
      void mobileCommanderSpeech.playBeep(host.prepared, "listen").then(() => {
        if (this.generation === myGen && this.isActiveFor(threadKey)) {
          void this.beginListeningTurn(threadKey, myGen);
        }
      });
    }, POST_SPEECH_RESUME_MS);
  }
}

export const mobileCommanderVoiceChat = new MobileCommanderVoiceChatController();

export function useMobileCommanderVoiceChatState(): MobileCommanderVoiceChatState {
  return useSyncExternalStore(
    mobileCommanderVoiceChat.subscribe,
    mobileCommanderVoiceChat.getSnapshot,
    mobileCommanderVoiceChat.getSnapshot,
  );
}
