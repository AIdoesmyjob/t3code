import { useSyncExternalStore } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { transcribeEnvironmentAudio } from "@t3tools/client-runtime/voice-input";
import { CommanderVoiceReply, type CommanderSpeakOutcome } from "@t3tools/shared/skofoSpeech";
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
import { mobileCommanderSpeech } from "./mobileCommanderSpeech";

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
  | "send-failed"
  | "still-working"
  | "no-reply"
  | "run-failed";

export type MobileVoiceChatErrorCode = "permission-denied" | "mic-error" | "transcribe-failed";

export interface MobileCommanderVoiceChatState {
  readonly activeThreadKey: string | null;
  readonly phase: MobileVoiceChatPhase;
  readonly level: number;
  readonly heardSpeech: boolean;
  readonly lastTranscript: string | null;
  readonly pendingMessageId: string | null;
  readonly hintCode: MobileVoiceChatHintCode | null;
  readonly errorCode: MobileVoiceChatErrorCode | null;
  readonly errorDetail: string | null;
}

export interface MobileCommanderVoiceChatHost {
  readonly prepared: PreparedConnection;
  readonly sendMessage: (text: string) => Promise<string | null>;
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
    pendingMessageId: null,
    hintCode: null,
    errorCode: null,
    errorDetail: null,
  };
  private listeners = new Set<() => void>();
  private hosts = new Map<string, MobileCommanderVoiceChatHost>();
  private generation = 0;
  private reply: CommanderVoiceReply | null = null;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private recorder: AudioRecorder | null = null;
  private recordingSession: AudioSessionToken | null = null;
  private recorderPreparation: Promise<void> | null = null;
  private recordingTeardown = Promise.resolve();
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
      if (this.hosts.get(threadKey) !== host) return;
      this.hosts.delete(threadKey);
      if (this.isActiveFor(threadKey)) this.pause();
      else mobileCommanderSpeech.stop();
    };
  }

  isActiveFor(threadKey: string | null): boolean {
    return (
      threadKey !== null && this.state.activeThreadKey === threadKey && this.state.phase !== "off"
    );
  }

  private clearTimers() {
    if (this.thinkingTimer !== null) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
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

  private releaseRecordingResources(keepUri = false): Promise<string | null> {
    this.clearTimers();
    const recorder = this.recorder;
    const session = this.recordingSession;
    const preparing = this.recorderPreparation;
    this.recorder = null;
    this.recordingSession = null;
    this.recorderPreparation = null;

    const teardown = this.recordingTeardown.then(async () => {
      let uri: string | null = null;
      if (recorder) {
        await preparing?.catch(() => {});
        try {
          if (recorder.isRecording) await recorder.stop();
        } catch {}
        try {
          uri = recorder.uri;
        } catch {
        } finally {
          try {
            recorder.release();
          } catch {}
        }
      }
      if (session) await releaseAudioSession(session).catch(() => {});
      if (keepUri) return uri;
      if (uri) {
        try {
          const file = new File(uri);
          if (file.exists) file.delete();
        } catch {}
      }
      return null;
    });
    this.recordingTeardown = teardown.then(
      () => {},
      () => {},
    );
    return teardown;
  }

  stop() {
    this.generation += 1;
    this.reply = null;
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
        pendingMessageId: null,
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
    this.reply = null;
    const myGen = this.generation;
    this.clearTimers();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    mobileCommanderSpeech.stop();
    mobileCommanderSpeech.setTalkBackEnabled(true);
    this.setKeepAwake(true);

    this.emit({
      activeThreadKey: threadKey,
      phase: "starting",
      pendingMessageId: null,
      level: 0,
      heardSpeech: false,
      hintCode: "requesting-mic",
      errorCode: null,
      errorDetail: null,
    });

    try {
      await this.releaseRecordingResources();
      if (this.generation !== myGen) return;
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
    await mobileCommanderSpeech.whenIdle();
    if (this.generation !== sessionGen) return;

    const session = acquireAudioSession("recording", () => {
      if (this.generation === sessionGen) {
        this.stop();
      }
    });
    this.recordingSession = session;

    try {
      const activated = await activateAudioSession(session);
      if (this.generation !== sessionGen) return;
      if (!activated) throw new Error("Could not activate recording audio session.");

      const recorder = new AudioModule.AudioRecorder(buildRecordingOptions());
      this.recorder = recorder;
      this.recorderPreparation = recorder.prepareToRecordAsync();
      await this.recorderPreparation;
      if (this.generation !== sessionGen) return;
      this.recorderPreparation = null;
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
      if (this.generation !== sessionGen) return;
      this.setKeepAwake(false);
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

    this.emit({
      phase: "transcribing",
      level: 0,
      hintCode: "transcribing",
    });

    const recordingUri = await this.releaseRecordingResources(true);
    if (this.generation !== sessionGen) {
      if (recordingUri) {
        try {
          new File(recordingUri).delete();
        } catch {}
      }
      return;
    }
    if (!recordingUri) {
      this.emit({ phase: "error", errorCode: "transcribe-failed", hintCode: null });
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

      let messageId: string | null;
      try {
        messageId = await host.sendMessage(transcript);
      } catch {
        messageId = null;
      }
      if (this.generation !== sessionGen) return;
      if (!messageId) {
        this.emit({ phase: "paused", lastTranscript: transcript, hintCode: "send-failed" });
        return;
      }

      this.reply = new CommanderVoiceReply(messageId);
      this.emit({
        phase: "thinking",
        pendingMessageId: messageId,
        level: 0,
        heardSpeech: false,
        lastTranscript: transcript,
        hintCode: "thinking",
        errorCode: null,
        errorDetail: null,
      });
      this.thinkingTimer = setTimeout(() => {
        this.thinkingTimer = null;
        if (this.generation === sessionGen && this.state.phase === "thinking") {
          this.emit({ hintCode: "still-working" });
        }
      }, 5_000);
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

  pause() {
    if (this.state.phase === "off") {
      mobileCommanderSpeech.stop();
      return;
    }
    this.generation += 1;
    this.reply = null;
    this.clearTimers();
    this.abortController?.abort();
    this.abortController = null;
    void this.releaseRecordingResources();
    this.setKeepAwake(false);
    mobileCommanderSpeech.stop();
    this.emit({
      phase: "paused",
      pendingMessageId: null,
      level: 0,
      heardSpeech: false,
      hintCode: "paused",
      errorCode: null,
      errorDetail: null,
    });
  }

  togglePause() {
    const threadKey = this.state.activeThreadKey;
    if (!threadKey) return;
    if (this.state.phase === "listening") {
      this.pause();
    } else if (this.state.phase === "paused" || this.state.phase === "error") {
      if (this.reply) {
        this.interruptAndListen();
      } else {
        void this.startForThread(threadKey);
      }
    }
  }

  interruptAndListen() {
    const threadKey = this.state.activeThreadKey;
    if (!threadKey || !this.reply) return;
    mobileCommanderSpeech.stop();
    this.finishReply(threadKey, this.reply, "completed");
  }

  observeReply(
    threadKey: string,
    run: { readonly id: string; readonly userMessageId: string; readonly status: string },
    text: string,
  ) {
    const reply = this.reply;
    if (!this.isActiveFor(threadKey) || reply?.messageId !== run.userMessageId) return;

    const action = reply.observe(run, text);
    if (!action) return;
    if (action.type === "listen") {
      this.resumeListening(threadKey);
      return;
    }
    if (action.type === "failed" || action.type === "empty") {
      this.clearTimers();
      this.reply = null;
      mobileCommanderSpeech.stop();
      this.emit({
        phase: "paused",
        pendingMessageId: null,
        hintCode: action.type === "failed" ? "run-failed" : "no-reply",
      });
      return;
    }
    const host = this.hosts.get(threadKey);
    if (!host) return;
    void mobileCommanderSpeech
      .speak({
        prepared: host.prepared,
        text: action.text,
        messageId: run.id,
        mode: "auto",
        onPlaying: () => {
          if (this.reply !== reply) return;
          this.clearTimers();
          this.emit({ phase: "speaking", hintCode: "speaking" });
        },
      })
      .then((outcome) => this.finishReply(threadKey, reply, outcome));
  }

  retryAudio() {
    const threadKey = this.state.activeThreadKey;
    const reply = this.reply;
    if (!threadKey || !reply) return;
    void mobileCommanderSpeech
      .retry()
      .then((outcome) => this.finishReply(threadKey, reply, outcome));
  }

  private finishReply(
    threadKey: string,
    reply: CommanderVoiceReply,
    outcome: CommanderSpeakOutcome,
  ) {
    if (this.reply !== reply || outcome === "stopped") return;
    if (reply.finishAudio(outcome)) {
      this.resumeListening(threadKey);
    } else if (outcome === "error") {
      this.clearTimers();
      this.emit({ phase: "paused", hintCode: "paused" });
    } else {
      this.emit({ phase: "thinking", hintCode: "still-working" });
    }
  }

  private resumeListening(threadKey: string) {
    const host = this.hosts.get(threadKey);
    if (!host) return;
    const generation = this.generation;
    this.reply = null;
    this.emit({ phase: "thinking", pendingMessageId: null });
    this.clearTimers();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void mobileCommanderSpeech.playBeep(host.prepared, "listen").then(() => {
        if (this.generation === generation) {
          void this.beginListeningTurn(threadKey, generation);
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
