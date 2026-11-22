import { useSyncExternalStore } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  fetchEnvironmentSpeechBeep,
  synthesizeEnvironmentSpeech,
} from "@t3tools/client-runtime/voice-input";
import type { SpeechBeepKind } from "@t3tools/contracts";
import { splitIntoSpokenSentences } from "@t3tools/shared/skofoSpeech";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";

import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";

type AudioSessionToken = ReturnType<typeof acquireAudioSession>;

export type MobileCommanderSpeakOutcome = "completed" | "stopped" | "error";

interface MobileCommanderSpeechState {
  readonly talkBackEnabled: boolean;
  readonly status: "idle" | "loading" | "speaking";
  readonly speakingMessageId: string | null;
  readonly error: string | null;
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
    player.pause();
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
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private fileSeq = 0;
  private abortController: AbortController | null = null;
  private activePlayer: AudioPlayer | null = null;
  private activeSession: AudioSessionToken | null = null;
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
    this.generation += 1;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.activePlayer) {
      const player = this.activePlayer;
      this.activePlayer = null;
      disposeAudioPlayer(player);
    }
    if (this.activeSession) {
      const session = this.activeSession;
      this.activeSession = null;
      void releaseAudioSession(session);
    }
    if (this.state.status !== "idle" || this.state.speakingMessageId !== null) {
      this.emit({ status: "idle", speakingMessageId: null });
    }
  }

  async playBeep(prepared: PreparedConnection, kind: SpeechBeepKind): Promise<void> {
    try {
      const cacheKey = `${prepared.environmentId}:${kind}`;
      let uri = this.beepUriCache.get(cacheKey);
      if (!uri) {
        const result = await runSpeech(fetchEnvironmentSpeechBeep(prepared, kind));
        const beepFile = new File(Paths.cache, `skofo-beep-${kind}.mp3`);
        beepFile.write(base64ToBytes(result.audioBase64));
        uri = beepFile.uri;
        this.beepUriCache.set(cacheKey, uri);
      }

      const session = acquireAudioSession("playback");
      const activated = await activateAudioSession(session);
      if (!activated) {
        await releaseAudioSession(session).catch(() => {});
        return;
      }

      const player = createAudioPlayer(uri, { updateInterval: 80 });
      try {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            sub.remove();
            resolve();
          };
          const watchdog = setTimeout(finish, 1_500);
          const sub = player.addListener("playbackStatusUpdate", (status) => {
            if (status.didJustFinish) finish();
          });
          try {
            player.play();
          } catch {
            finish();
          }
        });
      } finally {
        disposeAudioPlayer(player);
        await releaseAudioSession(session).catch(() => {});
      }
    } catch {
      // Never block voice chat turns on optional LCARS beep cues.
    }
  }

  async speak(input: {
    readonly prepared: PreparedConnection;
    readonly text: string;
    readonly messageId: string;
    readonly mode?: "auto" | "full";
  }): Promise<MobileCommanderSpeakOutcome> {
    const sentences = splitIntoSpokenSentences(input.text, { mode: input.mode ?? "full" });
    if (sentences.length === 0) return "completed";

    this.stop();
    const myGen = this.generation;
    const abort = new AbortController();
    this.abortController = abort;
    const session = acquireAudioSession("playback", () => {
      if (this.generation === myGen) {
        this.stop();
      }
    });
    this.activeSession = session;
    this.emit({ status: "loading", speakingMessageId: input.messageId, error: null });

    const canSend = () => !abort.signal.aborted && this.generation === myGen;
    const fetchSentence = (sentence: string) =>
      runSpeech(
        synthesizeEnvironmentSpeech(input.prepared, { text: sentence, format: "mp3" }, canSend),
        abort.signal,
        canSend,
      );

    try {
      const activated = await activateAudioSession(session);
      if (!activated || !canSend()) return "stopped";

      let nextPromise: Promise<{ readonly audioBase64: string; readonly mimeType: string }> | null =
        fetchSentence(sentences[0]!);

      for (let i = 0; i < sentences.length; i += 1) {
        if (!canSend()) return "stopped";
        const result = await nextPromise;
        if (!result || !canSend()) return "stopped";

        const nextSentence = sentences[i + 1];
        nextPromise = nextSentence ? fetchSentence(nextSentence) : null;

        this.fileSeq += 1;
        const ext = result.mimeType.includes("wav") ? "wav" : "mp3";
        const tempFile = new File(Paths.cache, `skofo-tts-${myGen}-${this.fileSeq}.${ext}`);
        tempFile.write(base64ToBytes(result.audioBase64));

        const player = createAudioPlayer(tempFile.uri, { updateInterval: 150 });
        this.activePlayer = player;
        this.emit({ status: "speaking", speakingMessageId: input.messageId });

        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (err?: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(watchdog);
              sub.remove();
              abort.signal.removeEventListener("abort", onAbort);
              if (err) reject(err);
              else resolve();
            };
            const onAbort = () => finish();
            const watchdog = setTimeout(() => finish(), 45_000);
            const sub = player.addListener("playbackStatusUpdate", (status) => {
              if (status.didJustFinish) {
                finish();
              }
            });
            abort.signal.addEventListener("abort", onAbort, { once: true });
            try {
              player.play();
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
            }
          });
        } finally {
          if (this.activePlayer === player) {
            this.activePlayer = null;
          }
          disposeAudioPlayer(player);
          try {
            if (tempFile.exists) tempFile.delete();
          } catch {
            // Ignore temp cleanup errors.
          }
        }
      }

      if (this.generation === myGen) {
        this.abortController = null;
        if (this.activeSession === session) {
          this.activeSession = null;
          void releaseAudioSession(session);
        }
        this.emit({ status: "idle", speakingMessageId: null });
        return "completed";
      }
      return "stopped";
    } catch (err) {
      if (this.generation !== myGen || abort.signal.aborted) return "stopped";
      const message = err instanceof Error ? err.message : String(err);
      this.stop();
      this.emit({ error: message });
      return "error";
    }
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
