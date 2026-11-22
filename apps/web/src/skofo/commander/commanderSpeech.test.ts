import { beforeEach, describe, expect, it } from "vite-plus/test";
import { commanderSpeechController } from "./commanderSpeech";

describe("commanderSpeechController", () => {
  beforeEach(() => {
    commanderSpeechController.stop();
    commanderSpeechController.setTalkBackEnabled(true);
  });

  it("toggles talk-back preference cleanly and starts idle", () => {
    expect(commanderSpeechController.getSnapshot().talkBackEnabled).toBe(true);
    expect(commanderSpeechController.getSnapshot().status).toBe("idle");

    commanderSpeechController.toggleTalkBack();
    expect(commanderSpeechController.getSnapshot().talkBackEnabled).toBe(false);

    commanderSpeechController.toggleTalkBack();
    expect(commanderSpeechController.getSnapshot().talkBackEnabled).toBe(true);
  });
});
