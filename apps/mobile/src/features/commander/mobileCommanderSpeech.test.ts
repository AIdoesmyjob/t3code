import { describe, expect, it, vi } from "vite-plus/test";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File } from "expo-file-system";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

vi.mock("expo-audio", () => ({
  AudioModule: {},
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(),
  setIsAudioActiveAsync: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  File: vi.fn(),
  Paths: { cache: "/tmp" },
}));
vi.mock("../voice-input/voiceDestination", () => ({ runSpeech: vi.fn() }));

import { acquireAudioSession, releaseAudioSession } from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";
import { mobileCommanderSpeech } from "./mobileCommanderSpeech";

const prepared = { environmentId: "test-android" } as PreparedConnection;

function makePlayer() {
  const started = Promise.withResolvers<void>();
  let onStatus: ((status: { playing: boolean; didJustFinish: boolean }) => void) | undefined;
  const pause = vi.fn();
  const remove = vi.fn();
  const player = {
    pause,
    remove,
    play: () => {
      onStatus?.({ playing: true, didJustFinish: false });
      started.resolve();
    },
    addListener: vi.fn((_: string, callback: typeof onStatus) => {
      onStatus = callback;
      return { remove: vi.fn() };
    }),
  };
  return {
    player: player as unknown as AudioPlayer,
    started: started.promise,
    finish: () => onStatus?.({ playing: false, didJustFinish: true }),
    remove,
  };
}

function setupPlayback() {
  mobileCommanderSpeech.stop();
  vi.mocked(runSpeech)
    .mockReset()
    .mockResolvedValue({ audioBase64: "AA==", mimeType: "audio/mp3" });
  vi.mocked(createAudioPlayer).mockReset();
  vi.mocked(File).mockImplementation(function () {
    return {
      uri: "file:///mock-audio",
      write: vi.fn(),
      delete: vi.fn(),
      exists: true,
    } as unknown as File;
  });
}

describe("mobileCommanderSpeech", () => {
  it("releases the acknowledgement player before starting a queued reply", async () => {
    setupPlayback();
    const cue = makePlayer();
    const reply = makePlayer();
    vi.mocked(createAudioPlayer).mockReturnValueOnce(cue.player).mockReturnValueOnce(reply.player);

    const cueCompletion = mobileCommanderSpeech.playBeep(prepared, "ack");
    const replyCompletion = mobileCommanderSpeech.speak({
      prepared,
      text: "Fleet is ready.",
      messageId: "voice-1",
    });
    await cue.started;
    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
    cue.finish();
    await cueCompletion;
    await reply.started;
    expect(cue.remove).toHaveBeenCalledOnce();
    reply.finish();
    expect(await replyCompletion).toBe("completed");
  });

  it("recovers when the recording session still owns audio and when playback times out", async () => {
    setupPlayback();
    const stalled = makePlayer();
    const retry = makePlayer();
    vi.mocked(createAudioPlayer)
      .mockReturnValueOnce(stalled.player)
      .mockReturnValueOnce(retry.player);
    const recording = acquireAudioSession("recording");
    try {
      expect(
        await mobileCommanderSpeech.speak({
          prepared,
          text: "Fleet is ready.",
          messageId: "voice-2",
        }),
      ).toBe("error");
      expect(mobileCommanderSpeech.getSnapshot()).toMatchObject({ canRetry: true });
      expect(createAudioPlayer).not.toHaveBeenCalled();
    } finally {
      await releaseAudioSession(recording);
    }

    vi.useFakeTimers();
    try {
      const firstAttempt = mobileCommanderSpeech.retry();
      await stalled.started;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await firstAttempt).toBe("error");
      expect(mobileCommanderSpeech.getSnapshot()).toMatchObject({ canRetry: true });
      const secondAttempt = mobileCommanderSpeech.retry();
      await retry.started;
      retry.finish();
      expect(await secondAttempt).toBe("completed");
      expect(runSpeech).toHaveBeenCalledTimes(1);
    } finally {
      mobileCommanderSpeech.stop();
      vi.useRealTimers();
    }
  });
});
