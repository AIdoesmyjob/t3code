import { useSyncExternalStore } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  fetchEnvironmentSpeechBeep,
  synthesizeEnvironmentSpeech,
} from "@t3tools/client-runtime/voice-input";
import type { SpeechBeepKind } from "@t3tools/contracts";
import { splitIntoSpokenSentences, type CommanderSpeakOutcome } from "@t3tools/shared/skofoSpeech";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";

import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
  pauseAudioPlayer,
} from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";

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
  clip: { readonly audioBase64: string; readonly mimeType: string } | null;
}

interface MobileCommanderSpeechState {
  readonly talkBackEnabled: boolean;
  readonly status: "idle" | "loading" | "speaking";
  readonly speakingMessageId: string | null;
  readonly error: string | null;
  readonly canRetry: boolean;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function disposeAudioPlayer(player: AudioPlayer): void {
  try {
    pauseAudioPlayer(player);
  } catch {
    // Ignore pause errors during teardown.
  }
  try {
    player.remove();
  } catch {
    // Ignore remove errors during teardown.
  }
}

class MobileCommanderSpeechController {
  private state: MobileCommanderSpeechState = {
    talkBackEnabled: true,
    status: "idle",
    speakingMessageId: null,
    error: null,
    canRetry: false,
  };
  private listeners = new Set<() => void>();
  private fileSeq = 0;
  private abortController = new AbortController();
  private audioQueue = Promise.resolve();
  private job: SpeechJob | null = null;
  private beepUriCache = new Map<string, string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MobileCommanderSpeechState => this.state;

  private emit(patch: Partial<MobileCommanderSpeechState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  setTalkBackEnabled(enabled: boolean) {
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

  stop() {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.job = null;
    if (this.state.status !== "idle" || this.state.canRetry) {
      this.emit({ status: "idle", speakingMessageId: null, error: null, canRetry: false });
    }
  }

  whenIdle(): Promise<void> {
    return this.audioQueue;
  }

  private enqueueAudio<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.audioQueue.then(operation);
    this.audioQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async withPlaybackSession(
    signal: AbortSignal,
    play: (signal: AbortSignal) => Promise<void>,
  ) {
    const playback = new AbortController();
    const cancel = () => playback.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let displaced = false;
    const session = acquireAudioSession("playback", () => {
      displaced = true;
      cancel();
    });
    try {
      if (!(await activateAudioSession(session))) {
        if (!signal.aborted) throw new Error("Could not activate audio playback.");
        return;
      }
      if (!playback.signal.aborted) await play(playback.signal);
      if (displaced && !signal.aborted) throw new Error("Audio playback was interrupted.");
    } finally {
      signal.removeEventListener("abort", cancel);
      await releaseAudioSession(session);
    }
  }

  private async playFile(
    uri: string,
    signal: AbortSignal,
    timeoutMs: number,
    onPlaying?: () => void,
  ) {
    if (signal.aborted) return;
    const player = createAudioPlayer(uri, { updateInterval: 80 });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          sub.remove();
          signal.removeEventListener("abort", onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onAbort = () => finish();
        const watchdog = setTimeout(
          () => finish(new Error("Audio playback timed out.")),
          timeoutMs,
        );
        const sub = player.addListener("playbackStatusUpdate", (status) => {
          if (status.playing) onPlaying?.();
          if (status.didJustFinish) finish();
        });
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          player.play();
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      disposeAudioPlayer(player);
    }
  }

  playBeep(prepared: PreparedConnection, kind: SpeechBeepKind): Promise<void> {
    const { signal } = this.abortController;
    return this.enqueueAudio(async () => {
      if (signal.aborted) return;
      try {
        const cacheKey = `${prepared.environmentId}:${kind}`;
        let uri = this.beepUriCache.get(cacheKey);
        if (!uri) {
          const result = await runSpeech(fetchEnvironmentSpeechBeep(prepared, kind), signal);
          if (signal.aborted) return;
          const beepFile = new File(Paths.cache, `skofo-beep-${kind}.mp3`);
          beepFile.write(base64ToBytes(result.audioBase64));
          uri = beepFile.uri;
          this.beepUriCache.set(cacheKey, uri);
        }
        await this.withPlaybackSession(signal, (playbackSignal) =>
          this.playFile(uri, playbackSignal, 1_500),
        );
      } catch {
        // Cues are optional.
      }
    });
  }

  speak(input: SpeechRequest): Promise<CommanderSpeakOutcome> {
    if (this.job) this.stop();
    const sentences = splitIntoSpokenSentences(input.text, { mode: input.mode ?? "full" });
    if (sentences.length === 0) return Promise.resolve("completed");
    const job: SpeechJob = { input, sentences, index: 0, clip: null };
    this.job = job;
    return this.playReply(job);
  }

  retry(): Promise<CommanderSpeakOutcome> {
    if (!this.job || !this.state.canRetry) return Promise.resolve("stopped");
    return this.playReply(this.job);
  }

  private playReply(job: SpeechJob): Promise<CommanderSpeakOutcome> {
    const { signal } = this.abortController;
    this.emit({
      status: "loading",
      speakingMessageId: job.input.messageId,
      error: null,
      canRetry: false,
    });
    return this.enqueueAudio(async () => {
      if (signal.aborted) return "stopped";
      try {
        await this.withPlaybackSession(signal, async (playbackSignal) => {
          const canSend = () => !playbackSignal.aborted;
          const fetchSentence = (sentence: string) =>
            runSpeech(
              synthesizeEnvironmentSpeech(
                job.input.prepared,
                { text: sentence, format: "mp3" },
                canSend,
              ),
              playbackSignal,
              canSend,
            );
          let nextPromise: Promise<{
            readonly audioBase64: string;
            readonly mimeType: string;
          }> | null = null;
          while (job.index < job.sentences.length) {
            const sentence = job.sentences[job.index]!;
            if (!job.clip) {
              const pending = nextPromise ?? fetchSentence(sentence);
              nextPromise = null;
              job.clip = await pending;
            }
            if (playbackSignal.aborted) return;
            const nextSentence = job.sentences[job.index + 1];
            if (nextSentence && !nextPromise) {
              nextPromise = fetchSentence(nextSentence);
              void nextPromise.catch(() => {});
            }
            const ext = job.clip.mimeType.includes("wav") ? "wav" : "mp3";
            this.fileSeq += 1;
            const tempFile = new File(Paths.cache, `skofo-tts-${this.fileSeq}.${ext}`);
            try {
              tempFile.write(base64ToBytes(job.clip.audioBase64));
              await this.playFile(tempFile.uri, playbackSignal, 45_000, () => {
                if (!playbackSignal.aborted && this.state.status !== "speaking") {
                  this.emit({ status: "speaking" });
                  job.input.onPlaying?.();
                }
              });
            } finally {
              try {
                if (tempFile.exists) tempFile.delete();
              } catch {}
            }
            if (playbackSignal.aborted) return;
            job.clip = null;
            job.index += 1;
          }
        });
        if (signal.aborted) return "stopped";
        this.job = null;
        this.emit({ status: "idle", speakingMessageId: null });
        return "completed";
      } catch (error) {
        if (signal.aborted) return "stopped";
        this.emit({
          status: "idle",
          error: error instanceof Error ? error.message : String(error),
          canRetry: true,
        });
        return "error";
      }
    });
  }
}

export const mobileCommanderSpeech = new MobileCommanderSpeechController();

export function useMobileCommanderSpeechState(): MobileCommanderSpeechState {
  return useSyncExternalStore(
    mobileCommanderSpeech.subscribe,
    mobileCommanderSpeech.getSnapshot,
    mobileCommanderSpeech.getSnapshot,
  );
}
