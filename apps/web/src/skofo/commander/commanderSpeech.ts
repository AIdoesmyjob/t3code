import { useSyncExternalStore } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type SpeechBeepKind,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  fetchEnvironmentSpeechBeep,
  synthesizeEnvironmentSpeech,
} from "@t3tools/client-runtime/voice-input";
import { splitIntoSpokenSentences, type CommanderSpeakOutcome } from "@t3tools/shared/skofoSpeech";
import * as Option from "effect/Option";

import { runEnvironmentSpeech } from "~/speech/runEnvironmentSpeech";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";

const TALK_BACK_STORAGE_KEY = "skofo.computer.talkBack";

const SILENT_AUDIO = `data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAAC${"AgIC".repeat(133)}A`;

interface SpeechRequest {
  readonly prepared: PreparedConnection;
  readonly text: string;
  readonly messageId: string;
  readonly mode?: "auto" | "full";
  readonly onPlaying?: () => void;
}

interface SpeechJob {
  readonly input: SpeechRequest;
  readonly sentences: ReadonlyArray<string>;
  index: number;
  clip: Blob | null;
}

interface CommanderSpeechState {
  readonly talkBackEnabled: boolean;
  readonly status: "idle" | "loading" | "speaking";
  readonly speakingMessageId: string | null;
  readonly error: string | null;
  readonly recovery: "play" | "retry" | null;
}

function readInitialTalkBack(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(TALK_BACK_STORAGE_KEY);
    if (raw === "0" || raw === "false") return false;
    return true;
  } catch {
    return true;
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

class CommanderSpeechController {
  private state: CommanderSpeechState = {
    talkBackEnabled: readInitialTalkBack(),
    status: "idle",
    speakingMessageId: null,
    error: null,
    recovery: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abortController = new AbortController();
  private audio: HTMLAudioElement | null = null;
  private cue = Promise.resolve();
  private job: SpeechJob | null = null;
  private beepCache = new Map<string, Blob>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CommanderSpeechState => this.state;

  private emit(patch: Partial<CommanderSpeechState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  setTalkBackEnabled(enabled: boolean) {
    try {
      globalThis.localStorage?.setItem(TALK_BACK_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Ignore storage failures in private browsing.
    }
    if (!enabled) {
      this.stop();
    }
    this.emit({ talkBackEnabled: enabled, error: null });
  }

  toggleTalkBack() {
    if (this.state.status !== "idle") {
      this.stop();
      return;
    }
    this.setTalkBackEnabled(!this.state.talkBackEnabled);
  }

  primePlayback() {
    if (typeof Audio === "undefined" || this.state.status !== "idle") return;
    const audio = (this.audio ??= new Audio());
    audio.src = SILENT_AUDIO;
    void audio.play().catch(() => {});
  }

  stop() {
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.job = null;
    if (this.state.status !== "idle" || this.state.recovery !== null) {
      this.emit({ status: "idle", speakingMessageId: null, error: null, recovery: null });
    }
  }

  private playBlob(
    blob: Blob,
    signal: AbortSignal,
    volume: number,
    onPlaying?: () => void,
    timeoutMs = 45_000,
  ) {
    const audio = (this.audio ??= new Audio());
    const url = URL.createObjectURL(blob);
    audio.src = url;
    audio.volume = volume;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        audio.onended = null;
        audio.onerror = null;
        signal.removeEventListener("abort", onAbort);
        audio.pause();
        URL.revokeObjectURL(url);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = () => finish();
      const watchdog = setTimeout(() => finish(new Error("Audio playback timed out.")), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("Audio playback failed."));
      try {
        void audio.play().then(() => {
          if (!settled && !signal.aborted) onPlaying?.();
        }, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  playBeep(prepared: PreparedConnection, kind: SpeechBeepKind): Promise<void> {
    if (typeof Audio === "undefined") return Promise.resolve();
    const { signal } = this.abortController;
    this.cue = this.cue.then(async () => {
      if (signal.aborted) return;
      try {
        const cacheKey = `${prepared.environmentId}:${kind}`;
        let blob = this.beepCache.get(cacheKey);
        if (!blob) {
          const result = await runEnvironmentSpeech(fetchEnvironmentSpeechBeep(prepared, kind), {
            signal,
          });
          blob = base64ToBlob(result.audioBase64, result.mimeType);
          this.beepCache.set(cacheKey, blob);
        }
        if (!signal.aborted) await this.playBlob(blob, signal, 0.65, undefined, 1_500);
      } catch {
        // Cues are optional.
      }
    });
    return this.cue;
  }

  async speak(input: SpeechRequest): Promise<CommanderSpeakOutcome> {
    if (this.state.status !== "idle" || this.job) this.stop();
    const sentences = splitIntoSpokenSentences(input.text, { mode: input.mode ?? "full" });
    if (sentences.length === 0) return "completed";

    const job: SpeechJob = { input, sentences, index: 0, clip: null };
    this.job = job;
    const generation = this.generation;
    this.emit({
      status: "loading",
      speakingMessageId: input.messageId,
      error: null,
      recovery: null,
    });
    await this.cue;
    return generation === this.generation ? this.playReply(job) : "stopped";
  }

  retry(): Promise<CommanderSpeakOutcome> {
    if (!this.job || !this.state.recovery) return Promise.resolve("stopped");
    this.emit({ status: "loading", error: null, recovery: null });
    return this.playReply(this.job);
  }

  private async playReply(job: SpeechJob): Promise<CommanderSpeakOutcome> {
    const generation = this.generation;
    const { signal } = this.abortController;
    const isCurrent = () => generation === this.generation && !signal.aborted;
    const fetchSentence = (sentence: string) =>
      runEnvironmentSpeech(
        synthesizeEnvironmentSpeech(
          job.input.prepared,
          { text: sentence, format: "mp3" },
          isCurrent,
        ),
        { signal },
      );
    let nextPromise: Promise<{ readonly audioBase64: string; readonly mimeType: string }> | null =
      null;
    try {
      while (job.index < job.sentences.length) {
        const sentence = job.sentences[job.index]!;
        if (!job.clip) {
          const pending = nextPromise ?? fetchSentence(sentence);
          nextPromise = null;
          const result = await pending;
          if (!isCurrent()) return "stopped";
          job.clip = base64ToBlob(result.audioBase64, result.mimeType);
        }
        const nextSentence = job.sentences[job.index + 1];
        if (nextSentence && !nextPromise) {
          nextPromise = fetchSentence(nextSentence);
          void nextPromise.catch(() => {});
        }
        await this.playBlob(job.clip, signal, 1, () => {
          if (this.state.status !== "speaking") {
            this.emit({ status: "speaking" });
            job.input.onPlaying?.();
          }
        });
        if (!isCurrent()) return "stopped";
        job.clip = null;
        job.index += 1;
      }
      this.job = null;
      this.emit({ status: "idle", speakingMessageId: null });
      return "completed";
    } catch (error) {
      if (!isCurrent()) return "stopped";
      const blocked = error instanceof Error && error.name === "NotAllowedError";
      this.emit({
        status: "idle",
        error: error instanceof Error ? error.message : String(error),
        recovery: blocked && job.clip ? "play" : "retry",
      });
      return "error";
    }
  }
}

export const commanderSpeechController = new CommanderSpeechController();

export function useCommanderSpeechState(): CommanderSpeechState {
  return useSyncExternalStore(
    commanderSpeechController.subscribe,
    commanderSpeechController.getSnapshot,
    commanderSpeechController.getSnapshot,
  );
}

export function useThreadVoiceSpeechOutput(
  environmentId: EnvironmentId | null,
): PreparedConnection | null {
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const supported = environment?.serverConfig?.environment.capabilities.voiceSpeechOutput === true;
  return supported && canOperate ? connection : null;
}
