import { describe, expect, it, vi } from "vite-plus/test";
import { runEnvironmentSpeech } from "~/speech/runEnvironmentSpeech";
import { commanderSpeechController } from "./commanderSpeech";

vi.mock("~/speech/runEnvironmentSpeech", () => ({ runEnvironmentSpeech: vi.fn() }));

describe("commanderSpeechController", () => {
  it("toggles talk-back while idle", () => {
    commanderSpeechController.stop();
    commanderSpeechController.setTalkBackEnabled(true);
    commanderSpeechController.toggleTalkBack();
    expect(commanderSpeechController.getSnapshot().talkBackEnabled).toBe(false);
    commanderSpeechController.toggleTalkBack();
    expect(commanderSpeechController.getSnapshot().talkBackEnabled).toBe(true);
  });

  it("primes one element and retries a blocked retained clip directly from the click", async () => {
    const play = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    const audio = {
      play,
      pause: vi.fn(),
      src: "",
      onended: null as (() => void) | null,
    };
    const createAudio = vi.fn(function () {
      return audio;
    });
    vi.stubGlobal("Audio", createAudio);
    vi.mocked(runEnvironmentSpeech).mockResolvedValue({
      audioBase64: "AA==",
      mimeType: "audio/mp3",
    });
    try {
      commanderSpeechController.primePlayback();
      expect(play).toHaveBeenCalledTimes(1);
      expect(audio.src).toMatch(/^data:audio\/wav/);
      const playing = vi.fn();
      expect(
        await commanderSpeechController.speak({
          prepared: { environmentId: "local" } as never,
          text: "Ready for instructions.",
          messageId: "reply",
          onPlaying: playing,
        }),
      ).toBe("error");
      expect(playing).not.toHaveBeenCalled();
      expect(commanderSpeechController.getSnapshot().recovery).toBe("play");

      const reply = commanderSpeechController.retry();
      expect(play).toHaveBeenCalledTimes(3);
      await Promise.resolve();
      expect(playing).toHaveBeenCalledTimes(1);
      audio.onended?.();
      expect(await reply).toBe("completed");
      expect(createAudio).toHaveBeenCalledTimes(1);
      expect(runEnvironmentSpeech).toHaveBeenCalledTimes(1);
    } finally {
      commanderSpeechController.stop();
      vi.unstubAllGlobals();
    }
  });
});
