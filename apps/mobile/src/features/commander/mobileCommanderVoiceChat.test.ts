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
const appStateMock = vi.hoisted(() => ({ currentState: "active" }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    get currentState() {
      return appStateMock.currentState;
    },
  },
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

  it("keeps Voice Chat alive while Android's permission dialog backgrounds the app", async () => {
    const supersededPermission =
      Promise.withResolvers<Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>>();
    const permission = Promise.withResolvers<{
      granted: boolean;
      status: string;
      canAskAgain: boolean;
      expires: string;
    }>();
    const recorder = {
      isRecording: false,
      uri: "file:///voice.m4a",
      prepareToRecordAsync: vi.fn(async () => {}),
      record: vi.fn(),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({ isRecording: true, metering: -50, url: "file:///voice.m4a" })),
      release: vi.fn(),
    };
    vi.mocked(AudioModule.AudioRecorder).mockImplementation(function () {
      return recorder as unknown as AudioRecorder;
    });
    vi.mocked(requestRecordingPermissionsAsync)
      .mockClear()
      .mockReturnValueOnce(supersededPermission.promise)
      .mockReturnValueOnce(
        permission.promise as ReturnType<typeof requestRecordingPermissionsAsync>,
      );
    const unregister = mobileCommanderVoiceChat.registerHost("env-1:thread-perm", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage: async () => "message-voice",
    });
    try {
      vi.mocked(runSpeech).mockRejectedValueOnce(new Error("skip-listen-beep"));
      const supersededStart = mobileCommanderVoiceChat.startForThread("env-1:thread-perm");
      await vi.waitFor(() => expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1));
      const starting = mobileCommanderVoiceChat.startForThread("env-1:thread-perm");
      await vi.waitFor(() => expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(2));

      supersededPermission.resolve({
        granted: true,
        status: "granted",
        canAskAgain: true,
        expires: "never",
      } as Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>);
      await supersededStart;

      // Android permission activity backgrounds the app.
      appStateMock.currentState = "background";
      mobileCommanderVoiceChat.handleAppStateChange("background");
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("starting");

      permission.resolve({ granted: true, status: "granted", canAskAgain: true, expires: "never" });
      await Promise.resolve();
      await Promise.resolve();

      // App returns to foreground after user taps Allow.
      appStateMock.currentState = "active";
      mobileCommanderVoiceChat.handleAppStateChange("active");
      await starting;

      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("listening");
      expect(recorder.record).toHaveBeenCalledWith({ forDuration: 45 });
    } finally {
      appStateMock.currentState = "active";
      mobileCommanderVoiceChat.stop();
      unregister();
    }
  });

  it.each([
    { mode: "hands-free", action: "on silence" },
    { mode: "hold", action: "only on release" },
  ] as const)("sends speech after silent Android samples $action", async ({ mode }) => {
    vi.useFakeTimers();
    const samples = [
      -160,
      -160,
      -48,
      -48, // initial Android 0-amplitude + ambient noise
      -30,
      -28,
      -27,
      -29, // normal speaking level on Android MediaRecorder
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
      -52,
    ];
    let idx = 0;
    const recorder = {
      isRecording: true,
      uri: "file:///speech.m4a",
      prepareToRecordAsync: vi.fn(async () => {}),
      record: vi.fn(),
      stop: vi.fn(async () => ({ url: "file:///speech.m4a" })),
      getStatus: vi.fn(() => ({
        isRecording: true,
        metering: samples[Math.min(idx++, samples.length - 1)]!,
        url: "file:///speech.m4a",
      })),
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
    const { File } = await import("expo-file-system");
    vi.mocked(File).mockImplementation(function () {
      return {
        exists: true,
        base64: async () => "AAAA",
        delete: vi.fn(),
      } as never;
    });
    const speech = vi.mocked(runSpeech);
    if (mode === "hands-free") speech.mockRejectedValueOnce(new Error("skip-listen-beep"));
    speech
      .mockRejectedValueOnce(new Error("skip-ack-beep"))
      .mockResolvedValueOnce({ text: "hello computer" } as never);
    const sendMessage = vi.fn(async () => "message-voice-vad");
    const unregister = mobileCommanderVoiceChat.registerHost("env-1:thread-vad", {
      prepared: { environmentId: "env-1" } as never,
      sendMessage,
    });
    try {
      await mobileCommanderVoiceChat.startForThread("env-1:thread-vad", mode);
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("listening");
      await vi.advanceTimersByTimeAsync(2_500);
      if (mode === "hold") {
        expect(sendMessage).not.toHaveBeenCalled();
        expect(recorder.stop).not.toHaveBeenCalled();
        expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("listening");
        mobileCommanderVoiceChat.finishHold("env-1:thread-vad", true);
        mobileCommanderVoiceChat.finishHold("env-1:thread-vad", true);
      }
      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith("hello computer");
      });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("thinking");
    } finally {
      vi.useRealTimers();
      mobileCommanderVoiceChat.stop();
      unregister();
    }
  });

  it("releasing during the permission request discards the hold", async () => {
    const permissionRequested = Promise.withResolvers<void>();
    const permission =
      Promise.withResolvers<Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>>();
    vi.mocked(requestRecordingPermissionsAsync).mockImplementationOnce(() => {
      permissionRequested.resolve();
      return permission.promise;
    });
    vi.mocked(AudioModule.AudioRecorder).mockClear();
    const threadKey = "env-1:released-before-mic";
    const sendMessage = vi.fn(async () => "message-voice");
    const unregister = mobileCommanderVoiceChat.registerHost(threadKey, {
      prepared: { environmentId: "env-1" } as never,
      sendMessage,
    });
    try {
      const starting = mobileCommanderVoiceChat.startForThread(threadKey, "hold");
      await permissionRequested.promise;
      mobileCommanderVoiceChat.finishHold(threadKey, true);
      permission.resolve({
        granted: true,
        status: "granted",
        canAskAgain: true,
        expires: "never",
      } as Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>);
      await starting;
      expect(AudioModule.AudioRecorder).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(mobileCommanderVoiceChat.getSnapshot().phase).toBe("off");
    } finally {
      mobileCommanderVoiceChat.stop();
      unregister();
    }
  });
});
