import { describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: vi.fn(),
}));

import { mobileCommanderSpeech } from "./mobileCommanderSpeech";

describe("mobileCommanderSpeech", () => {
  it("defaults talk-back enabled and toggles cleanly", () => {
    mobileCommanderSpeech.setTalkBackEnabled(true);
    expect(mobileCommanderSpeech.getSnapshot().talkBackEnabled).toBe(true);
    expect(mobileCommanderSpeech.getSnapshot().status).toBe("idle");

    mobileCommanderSpeech.toggleTalkBack();
    expect(mobileCommanderSpeech.getSnapshot().talkBackEnabled).toBe(false);

    mobileCommanderSpeech.setTalkBackEnabled(true);
    expect(mobileCommanderSpeech.getSnapshot().talkBackEnabled).toBe(true);
  });
});
