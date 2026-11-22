import { useSyncExternalStore } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { transcribeEnvironmentAudio } from "@t3tools/client-runtime/voice-input";
import { CommanderVoiceReply, type CommanderSpeakOutcome } from "@t3tools/shared/skofoSpeech";

import { runEnvironmentSpeech } from "~/speech/runEnvironmentSpeech";
import { commanderSpeechController } from "./commanderSpeech";

export type VoiceChatPhase =
  | "off"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused"
  | "error";

export type VoiceChatHintCode =
  | "opening-mic"
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

export type VoiceChatErrorCode =
  | "unsupported"
  | "permission-denied"
  | "mic-error"
  | "transcribe-failed";

export interface CommanderVoiceChatState {
  readonly activeThreadKey: string | null;
  readonly phase: VoiceChatPhase;
  readonly level: number;
  readonly heardSpeech: boolean;
  readonly lastTranscript: string | null;
  readonly pendingMessageId: string | null;
  readonly hintCode: VoiceChatHintCode | null;
  readonly errorCode: VoiceChatErrorCode | null;
  readonly errorDetail: string | null;
}

export interface CommanderVoiceChatHost {
  readonly prepared: PreparedConnection;
  readonly sendMessage: (text: string) => Promise<string | null>;
}

const VAD_POLL_MS = 50;
const NOISE_CALIBRATION_MS = 320;
const SPEECH_ONSET_MIN_MS = 180;
const SILENCE_END_MS = 1_350;
const MAX_UTTERANCE_MS = 45_000;
const IDLE_LISTEN_TIMEOUT_MS = 22_000;
const POST_SPEECH_RESUME_MS = 350;

function pickPreferredMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return globalThis.btoa(binary);
}

class CommanderVoiceChatController {
  private state: CommanderVoiceChatState = {
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
  private hosts = new Map<string, CommanderVoiceChatHost>();
  private generation = 0;
  private reply: CommanderVoiceReply | null = null;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CommanderVoiceChatState => this.state;

  private emit(patch: Partial<CommanderVoiceChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  registerHost(threadKey: string, host: CommanderVoiceChatHost): () => void {
    this.hosts.set(threadKey, host);
    return () => {
      if (this.hosts.get(threadKey) !== host) return;
      this.hosts.delete(threadKey);
      if (this.isActiveFor(threadKey)) this.pause();
      else commanderSpeechController.stop();
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

  private teardownRecorder(discard: boolean) {
    this.clearTimers();
    const rec = this.recorder;
    this.recorder = null;
    if (rec) {
      if (discard) {
        rec.ondataavailable = null;
        rec.onstop = null;
      }
      if (rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // Ignore recorder teardown errors.
        }
      }
    }
    if (discard) {
      this.chunks = [];
    }
  }

  private teardownAudioHardware() {
    this.teardownRecorder(true);
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      this.analyser = null;
      void ctx.close().catch(() => {});
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track teardown errors.
        }
      }
      this.stream = null;
    }
  }

  stop() {
    this.generation += 1;
    this.reply = null;
    this.teardownAudioHardware();
    commanderSpeechController.stop();
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
    commanderSpeechController.stop();
    commanderSpeechController.primePlayback();
    await this.startForThread(threadKey);
  }

  async startForThread(threadKey: string): Promise<void> {
    const host = this.hosts.get(threadKey);
    if (!host) return;

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      this.emit({
        activeThreadKey: threadKey,
        phase: "error",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: "unsupported",
        errorDetail: null,
      });
      return;
    }

    this.generation += 1;
    this.reply = null;
    const myGen = this.generation;
    this.teardownAudioHardware();
    commanderSpeechController.stop();
    commanderSpeechController.setTalkBackEnabled(true);
    this.emit({
      activeThreadKey: threadKey,
      phase: "starting",
      pendingMessageId: null,
      level: 0,
      heardSpeech: false,
      hintCode: "opening-mic",
      errorCode: null,
      errorDetail: null,
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.generation !== myGen) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const AudioCtx =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.25;
        source.connect(analyser);
        this.audioContext = ctx;
        this.analyser = analyser;
      }

      await commanderSpeechController.playBeep(host.prepared, "listen");
      if (this.generation !== myGen) return;
      this.beginListeningTurn(threadKey, myGen);
    } catch (err) {
      if (this.generation !== myGen) return;
      const isDenied = err instanceof Error && err.name === "NotAllowedError";
      this.teardownAudioHardware();
      this.emit({
        activeThreadKey: threadKey,
        phase: "error",
        level: 0,
        heardSpeech: false,
        hintCode: null,
        errorCode: isDenied ? "permission-denied" : "mic-error",
        errorDetail: err instanceof Error ? err.message : null,
      });
    }
  }

  private beginListeningTurn(threadKey: string, sessionGen: number) {
    if (this.generation !== sessionGen || !this.stream) return;
    const host = this.hosts.get(threadKey);
    if (!host) {
      this.stop();
      return;
    }

    this.teardownRecorder(true);
    if (this.audioContext?.state === "suspended") {
      void this.audioContext.resume().catch(() => {});
    }

    const mimeType = pickPreferredMimeType();
    const recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.recorder = recorder;
    this.chunks = [];

    recorder.ondataavailable = (event) => {
      if (this.generation === sessionGen && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (this.generation !== sessionGen) return;
      const blob = new Blob(this.chunks, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      this.chunks = [];
      void this.transcribeAndSend(threadKey, sessionGen, blob);
    };

    recorder.start(250);
    this.emit({
      activeThreadKey: threadKey,
      phase: "listening",
      level: 0,
      heardSpeech: false,
      hintCode: "listening",
      errorCode: null,
      errorDetail: null,
    });

    const analyser = this.analyser;
    const samples = analyser ? new Float32Array(analyser.fftSize) : null;
    const startedAt = Date.now();
    let noiseSamples = 0;
    let noiseSum = 0;
    let noiseFloor = 0.008;
    let speechMs = 0;
    let heardSpeech = false;
    let silenceMs = 0;

    this.vadTimer = setInterval(() => {
      if (this.generation !== sessionGen || this.state.phase !== "listening") {
        this.clearTimers();
        return;
      }
      const elapsed = Date.now() - startedAt;
      let rms = 0;
      if (analyser && samples) {
        analyser.getFloatTimeDomainData(samples);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const v = samples[i] ?? 0;
          sumSq += v * v;
        }
        rms = Math.sqrt(sumSq / samples.length);
      }

      if (elapsed <= NOISE_CALIBRATION_MS) {
        noiseSum += rms;
        noiseSamples += 1;
        noiseFloor = Math.min(0.03, Math.max(0.004, noiseSum / Math.max(1, noiseSamples)));
      }

      const onsetThreshold = Math.max(0.02, noiseFloor * 2.4);
      const releaseThreshold = Math.max(0.013, noiseFloor * 1.55);
      const visualLevel = Math.min(1, rms / 0.12);

      if (rms >= onsetThreshold) {
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
      } else if (heardSpeech && rms < releaseThreshold) {
        silenceMs += VAD_POLL_MS;
      } else if (!heardSpeech) {
        speechMs = Math.max(0, speechMs - VAD_POLL_MS);
      }

      this.emit({ level: visualLevel });

      if (heardSpeech && (silenceMs >= SILENCE_END_MS || elapsed >= MAX_UTTERANCE_MS)) {
        this.finishUtterance();
        return;
      }

      if (!heardSpeech && elapsed >= IDLE_LISTEN_TIMEOUT_MS) {
        this.teardownRecorder(true);
        this.emit({
          phase: "paused",
          level: 0,
          heardSpeech: false,
          hintCode: "paused-silence",
        });
      }
    }, VAD_POLL_MS);
  }

  sendNow() {
    if (this.state.phase !== "listening") return;
    this.finishUtterance();
  }

  private finishUtterance() {
    if (this.state.phase !== "listening" || !this.recorder) return;
    this.clearTimers();
    this.emit({
      phase: "transcribing",
      level: 0,
      hintCode: "transcribing",
    });
    const rec = this.recorder;
    this.recorder = null;
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Ignore stop race.
      }
    }
  }

  private async transcribeAndSend(threadKey: string, sessionGen: number, blob: Blob) {
    const host = this.hosts.get(threadKey);
    if (!host || this.generation !== sessionGen) return;
    if (blob.size < 400) {
      this.beginListeningTurn(threadKey, sessionGen);
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    void commanderSpeechController.playBeep(host.prepared, "ack");

    try {
      const audioBase64 = await blobToBase64(blob);
      if (this.generation !== sessionGen || abort.signal.aborted) return;

      const result = await runEnvironmentSpeech(
        transcribeEnvironmentAudio(
          host.prepared,
          {
            audioBase64,
            mimeType: blob.type || "audio/webm",
            language: "en",
          },
          () => !abort.signal.aborted && this.generation === sessionGen,
        ),
        { signal: abort.signal },
      );

      if (this.generation !== sessionGen || abort.signal.aborted) return;
      this.abortController = null;

      const transcript = result.text.trim();
      if (!transcript) {
        this.emit({ hintCode: "missed" });
        this.beginListeningTurn(threadKey, sessionGen);
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
      commanderSpeechController.stop();
      return;
    }
    this.generation += 1;
    this.reply = null;
    this.clearTimers();

    this.teardownAudioHardware();
    commanderSpeechController.stop();
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
        commanderSpeechController.primePlayback();
        void this.startForThread(threadKey);
      }
    }
  }

  interruptAndListen() {
    const threadKey = this.state.activeThreadKey;
    if (!threadKey || !this.reply) return;
    commanderSpeechController.stop();
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
      commanderSpeechController.stop();
      this.emit({
        phase: "paused",
        pendingMessageId: null,
        hintCode: action.type === "failed" ? "run-failed" : "no-reply",
      });
      return;
    }
    const host = this.hosts.get(threadKey);
    if (!host) return;
    void commanderSpeechController
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
    void commanderSpeechController
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
      void commanderSpeechController.playBeep(host.prepared, "listen").then(() => {
        if (this.generation === generation) {
          this.beginListeningTurn(threadKey, generation);
        }
      });
    }, POST_SPEECH_RESUME_MS);
  }
}

export const commanderVoiceChatController = new CommanderVoiceChatController();

export function useCommanderVoiceChatState(): CommanderVoiceChatState {
  return useSyncExternalStore(
    commanderVoiceChatController.subscribe,
    commanderVoiceChatController.getSnapshot,
    commanderVoiceChatController.getSnapshot,
  );
}
