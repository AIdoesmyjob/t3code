import { describe, expect, it, vi } from "vite-plus/test";
import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setIsAudioActiveAsync,
  type AudioRecorder,
} from "expo-audio";
import { runSpeech } from "../voice-input/voiceDestination";

vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: vi.fn(),
}));
vi.mock("expo-audio", () => ({
  AudioModule: { AudioRecorder: vi.fn() },
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: false })),
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: vi.fn(async () => {}),
}));
vi.mock("expo-file-system", () => ({
  File: vi.fn(),
  Paths: { cache: "/tmp" },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: vi.fn(async () => {}),
  deactivateKeepAwake: vi.fn(async () => {}),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

import { mobileCommanderVoiceChat } from "./mobileCommanderVoiceChat";

describe("mobileCommanderVoiceChat", () => {
  it("reports permission-denied error code when microphone permission is denied", async () => {
    const unregister = mobileCommanderVoiceChat.registerHost("env-1:thread-1", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage: async () => "message-voice",
    });
    await mobileCommanderVoiceChat.startForThread("env-1:thread-1");
    const snap = mobileCommanderVoiceChat.getSnapshot();
    expect(snap.phase).toBe("error");
    expect(snap.errorCode).toBe("permission-denied");
    mobileCommanderVoiceChat.stop();
    expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("off");
    unregister();
  });

  it("waits for native recording shutdown and recovers when the recorder returns no URI", async () => {
    const releaseStarted = Promise.withResolvers<void>();
    const allowRelease = Promise.withResolvers<void>();
    const recorder = {
      isRecording: true,
      uri: null,
      prepareToRecordAsync: vi.fn(async () => {}),
      record: vi.fn(),
      stop: vi.fn(async () => {}),
      release: vi.fn(),
    };
    vi.mocked(AudioModule.AudioRecorder).mockImplementation(function () {
      return recorder as unknown as AudioRecorder;
    });
    vi.mocked(requestRecordingPermissionsAsync).mockResolvedValueOnce({
      granted: true,
      status: "granted",
      canAskAgain: true,
      expires: "never",
    } as Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>);
    vi.mocked(setIsAudioActiveAsync).mockImplementation(async (active) => {
      if (!active) {
        releaseStarted.resolve();
        await allowRelease.promise;
      }
    });
    const sendMessage = vi.fn(async () => "message-voice");
    const unregister = mobileCommanderVoiceChat.registerHost("env-1:thread-1", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage,
    });
    const recovered = Promise.withResolvers<void>();
    const unsubscribe = mobileCommanderVoiceChat.subscribe(() => {
      if (mobileCommanderVoiceChat.getSnapshot().phase === "error") recovered.resolve();
    });
    try {
      await mobileCommanderVoiceChat.startForThread("env-1:thread-1");
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("listening");
      vi.mocked(runSpeech).mockClear();
      mobileCommanderVoiceChat.sendNow();
      await releaseStarted.promise;
      expect(recorder.stop).toHaveBeenCalledOnce();
      expect(recorder.release).toHaveBeenCalledOnce();
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("transcribing");
      expect(runSpeech).not.toHaveBeenCalled();
      allowRelease.resolve();
      await recovered.promise;
      expect(mobileCommanderVoiceChat.getSnapshot()).toMatchObject({
        phase: "error",
        errorCode: "transcribe-failed",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      allowRelease.resolve();
      unsubscribe();
      unregister();
      mobileCommanderVoiceChat.stop();
    }
  });
});
