import { useSyncExternalStore } from "react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { synthesizeEnvironmentSpeech } from "@t3tools/client-runtime/voice-input";
import { splitIntoSpokenSentences } from "@t3tools/shared/skofoSpeech";
import * as Option from "effect/Option";

import { runEnvironmentSpeech } from "~/speech/runEnvironmentSpeech";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";

const TALK_BACK_STORAGE_KEY = "skofo.computer.talkBack";

interface CommanderSpeechState {
  readonly talkBackEnabled: boolean;
  readonly status: "idle" | "loading" | "speaking";
  readonly speakingMessageId: string | null;
  readonly error: string | null;
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
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abortController: AbortController | null = null;
  private activeAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;

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

  stop() {
    this.generation += 1;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.src = "";
      } catch {
        // Ignore teardown errors.
      }
      this.activeAudio = null;
    }
    if (this.activeObjectUrl) {
      URL.revokeObjectURL(this.activeObjectUrl);
      this.activeObjectUrl = null;
    }
    if (this.state.status !== "idle" || this.state.speakingMessageId !== null) {
      this.emit({ status: "idle", speakingMessageId: null });
    }
  }

  async speak(input: {
    readonly prepared: PreparedConnection;
    readonly text: string;
    readonly messageId: string;
  }): Promise<void> {
    const sentences = splitIntoSpokenSentences(input.text);
    if (sentences.length === 0) return;

    this.stop();
    const myGen = this.generation;
    const abort = new AbortController();
    this.abortController = abort;
    this.emit({ status: "loading", speakingMessageId: input.messageId, error: null });

    const fetchSentence = (sentence: string) =>
      runEnvironmentSpeech(
        synthesizeEnvironmentSpeech(
          input.prepared,
          { text: sentence, format: "mp3" },
          () => !abort.signal.aborted && this.generation === myGen,
        ),
        { signal: abort.signal },
      );

    try {
      let nextPromise: Promise<{ readonly audioBase64: string; readonly mimeType: string }> | null =
        fetchSentence(sentences[0]!);

      for (let i = 0; i < sentences.length; i += 1) {
        if (this.generation !== myGen || abort.signal.aborted) return;
        const result = await nextPromise;
        if (!result || this.generation !== myGen || abort.signal.aborted) return;

        // Pipeline next sentence synthesis while this sentence plays
        const nextSentence = sentences[i + 1];
        nextPromise = nextSentence ? fetchSentence(nextSentence) : null;

        const blob = base64ToBlob(result.audioBase64, result.mimeType);
        const url = URL.createObjectURL(blob);
        this.activeObjectUrl = url;
        const audio = new Audio(url);
        this.activeAudio = audio;
        this.emit({ status: "speaking", speakingMessageId: input.messageId });

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            audio.onended = null;
            audio.onerror = null;
            abort.signal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            cleanup();
            resolve();
          };
          audio.onended = () => {
            cleanup();
            resolve();
          };
          audio.onerror = () => {
            cleanup();
            reject(new Error("Audio playback failed."));
          };
          abort.signal.addEventListener("abort", onAbort, { once: true });
          const playPromise = audio.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch((err: unknown) => {
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          }
        });

        if (this.activeAudio === audio) {
          this.activeAudio = null;
        }
        if (this.activeObjectUrl === url) {
          URL.revokeObjectURL(url);
          this.activeObjectUrl = null;
        }
      }

      if (this.generation === myGen) {
        this.abortController = null;
        this.emit({ status: "idle", speakingMessageId: null });
      }
    } catch (err) {
      if (this.generation !== myGen || abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      this.stop();
      this.emit({ error: message });
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
