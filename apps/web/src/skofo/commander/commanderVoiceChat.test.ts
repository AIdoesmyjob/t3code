import { describe, expect, it, vi } from "vite-plus/test";
import type { CommanderSpeakOutcome } from "@t3tools/shared/skofoSpeech";
import { runEnvironmentSpeech } from "~/speech/runEnvironmentSpeech";
import { commanderSpeechController } from "./commanderSpeech";
import { commanderVoiceChatController } from "./commanderVoiceChat";

vi.mock("~/speech/runEnvironmentSpeech", () => ({ runEnvironmentSpeech: vi.fn() }));
vi.mock("./commanderSpeech", () => ({
  commanderSpeechController: {
    stop: vi.fn(),
    setTalkBackEnabled: vi.fn(),
    playBeep: vi.fn(async () => {}),
    speak: vi.fn(),
  },
}));

describe("commanderVoiceChatController", () => {
  it("reports an unsupported error code when browser microphone APIs are unavailable", async () => {
    const unregister = commanderVoiceChatController.registerHost("env-1:thread-2", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage: async () => "message-voice",
    });
    try {
      await commanderVoiceChatController.startForThread("env-1:thread-2");
      expect(commanderVoiceChatController.getSnapshot()).toMatchObject({
        phase: "error",
        errorCode: "unsupported",
      });
    } finally {
      commanderVoiceChatController.stop();
      unregister();
    }
  });

  it("waits for acceptance, speaks only the correlated brief and rearms after settlement", async () => {
    class TestRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["a".repeat(510)]) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", TestRecorder);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
    });
    vi.useFakeTimers();

    const dispatchStarted = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<string>();
    const thinking = Promise.withResolvers<void>();
    const playback = Promise.withResolvers<CommanderSpeakOutcome>();
    vi.mocked(runEnvironmentSpeech).mockResolvedValue({ text: "How is the fleet?" });
    vi.mocked(commanderSpeechController.speak).mockImplementation(({ onPlaying }) => {
      onPlaying?.();
      return playback.promise;
    });
    const threadKey = "env-1:computer";
    const unregister = commanderVoiceChatController.registerHost(threadKey, {
      prepared: { environmentId: "env-1" } as never,
      sendMessage: () => {
        dispatchStarted.resolve();
        return receipt.promise;
      },
    });
    const unsubscribe = commanderVoiceChatController.subscribe(() => {
      if (commanderVoiceChatController.getSnapshot().phase === "thinking") thinking.resolve();
    });
    const ownRun = { id: "voice-run", userMessageId: "message-voice", status: "running" };
    try {
      await commanderVoiceChatController.startForThread(threadKey);
      commanderVoiceChatController.sendNow();
      await dispatchStarted.promise;
      expect(commanderVoiceChatController.getSnapshot().phase).toBe("transcribing");
      receipt.resolve("message-voice");
      await thinking.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(commanderVoiceChatController.getSnapshot().hintCode).toBe("still-working");

      commanderVoiceChatController.observeReply(
        threadKey,
        { id: "watcher-run", userMessageId: "wake", status: "completed" },
        "Unrelated update.",
      );
      commanderVoiceChatController.observeReply(threadKey, ownRun, "<!-- spoken: Fleet");
      expect(commanderSpeechController.speak).not.toHaveBeenCalled();
      const brief = "<!-- spoken: Fleet is ready. -->";
      commanderVoiceChatController.observeReply(threadKey, ownRun, brief);
      commanderVoiceChatController.observeReply(threadKey, ownRun, brief + "\nMore");
      expect(commanderSpeechController.speak).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Fleet is ready.", messageId: ownRun.id }),
      );
      expect(commanderVoiceChatController.getSnapshot().phase).toBe("speaking");
      playback.resolve("completed");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commanderVoiceChatController.getSnapshot().phase).toBe("thinking");
      commanderVoiceChatController.observeReply(
        threadKey,
        { ...ownRun, status: "completed" },
        brief,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commanderVoiceChatController.getSnapshot().phase).toBe("listening");
      expect(commanderSpeechController.speak).toHaveBeenCalledOnce();
    } finally {
      commanderVoiceChatController.stop();
      unregister();
      unsubscribe();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
