import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: vi.fn(),
}));
vi.mock("expo-audio", () => ({
  AudioModule: { AudioRecorder: vi.fn() },
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: false })),
  createAudioPlayer: vi.fn(),
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
      sendMessage: async () => true,
    });
    await mobileCommanderVoiceChat.startForThread("env-1:thread-1");
    const snap = mobileCommanderVoiceChat.getSnapshot();
    expect(snap.phase).toBe("error");
    expect(snap.errorCode).toBe("permission-denied");
    mobileCommanderVoiceChat.stop();
    expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("off");
    unregister();
  });
});
