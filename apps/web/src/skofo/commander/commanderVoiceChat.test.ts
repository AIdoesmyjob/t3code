import { describe, expect, it, vi } from "vite-plus/test";
import { commanderVoiceChatController } from "./commanderVoiceChat";

describe("commanderVoiceChatController", () => {
  it("tracks registered hosts and cleanly stops on host unregister", () => {
    const sendMessage = vi.fn(() => true);
    const unregister = commanderVoiceChatController.registerHost("env-1:thread-1", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage,
    });
    expect(commanderVoiceChatController.getSnapshot().phase).toBe("off");
    expect(commanderVoiceChatController.isActiveFor("env-1:thread-1")).toBe(false);
    unregister();
    expect(commanderVoiceChatController.getSnapshot().phase).toBe("off");
  });

  it("reports an unsupported error code when browser microphone APIs are unavailable", async () => {
    const unregister = commanderVoiceChatController.registerHost("env-1:thread-2", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage: () => true,
    });
    await commanderVoiceChatController.startForThread("env-1:thread-2");
    const snap = commanderVoiceChatController.getSnapshot();
    expect(snap.phase).toBe("error");
    expect(snap.errorCode).toBe("unsupported");
    commanderVoiceChatController.stop();
    expect(commanderVoiceChatController.getSnapshot().phase).toBe("off");
    unregister();
  });
});
