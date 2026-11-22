import { memo, useEffect, useEffectEvent, useRef } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  AudioLinesIcon,
  MicIcon,
  PauseIcon,
  PhoneOffIcon,
  SendHorizontalIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Text } from "~/components/ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadShell } from "~/state/entities";
import type { ChatMessage } from "~/types";
import {
  consumeCommanderDictation,
  isCommanderThread,
  subscribeCommanderDictation,
} from "./commanderConstants";
import {
  commanderSpeechController,
  useCommanderSpeechState,
  useThreadVoiceSpeechOutput,
} from "./commanderSpeech";
import {
  commanderVoiceChatController,
  useCommanderVoiceChatState,
  type VoiceChatErrorCode,
  type VoiceChatHintCode,
} from "./commanderVoiceChat";

const WAVE_BARS = [
  { id: "b1", weight: 0.45 },
  { id: "b2", weight: 0.85 },
  { id: "b3", weight: 1.0 },
  { id: "b4", weight: 0.7 },
  { id: "b5", weight: 0.5 },
] as const;

export const CommanderVoiceHeaderButton = memo(function CommanderVoiceHeaderButton({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const thread = useThreadShell({ environmentId, threadId });
  const prepared = useThreadVoiceSpeechOutput(environmentId);
  const speech = useCommanderSpeechState();
  const voiceChat = useCommanderVoiceChatState();

  if (!prepared || !thread || !isCommanderThread(thread)) {
    return null;
  }

  const threadKey = `${environmentId}:${threadId}`;
  const isVoiceChatActive = voiceChat.activeThreadKey === threadKey && voiceChat.phase !== "off";
  const isSpeaking = speech.status !== "idle";
  const talkBackLabel = isSpeaking
    ? gt("Stop Computer voice")
    : speech.talkBackEnabled
      ? gt("Mute Computer talk-back")
      : gt("Enable Computer talk-back");
  const voiceChatLabel = isVoiceChatActive
    ? gt("End Voice Chat with Computer")
    : gt("Start live Voice Chat with Computer");

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs-pill"
              variant={isVoiceChatActive ? "destructive" : "info-tint"}
              aria-label={voiceChatLabel}
              aria-pressed={isVoiceChatActive}
              onClick={() => void commanderVoiceChatController.toggleForThread(threadKey)}
            />
          }
        >
          {isVoiceChatActive ? (
            <PhoneOffIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
          <span className="hidden sm:inline">
            {isVoiceChatActive ? <T>End Voice</T> : <T>Voice Chat</T>}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{voiceChatLabel}</TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs-pill"
              variant={isSpeaking ? "secondary" : "ghost"}
              aria-label={talkBackLabel}
              aria-pressed={speech.talkBackEnabled}
              onClick={() => commanderSpeechController.toggleTalkBack()}
            />
          }
        >
          {isSpeaking ? (
            <SquareIcon className="size-3 fill-current" />
          ) : speech.talkBackEnabled ? (
            <Volume2Icon className="size-3.5" />
          ) : (
            <VolumeXIcon className="size-3.5 text-muted-foreground" />
          )}
          <span className="hidden md:inline">
            {isSpeaking ? <T>Stop</T> : speech.talkBackEnabled ? <T>Voice on</T> : <T>Voice off</T>}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{talkBackLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const CommanderVoiceChatBar = memo(function CommanderVoiceChatBar({
  environmentId,
  threadId,
  isCommander,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isCommander: boolean;
}) {
  const gt = useGT();
  const voiceChat = useCommanderVoiceChatState();
  const threadKey = `${environmentId}:${threadId}`;
  const active =
    isCommander && voiceChat.activeThreadKey === threadKey && voiceChat.phase !== "off";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Spacebar shortcut for barge-in or instant send while Voice Chat is active and no text input is focused
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('[contenteditable="true"]'))
      ) {
        return;
      }
      if (voiceChat.phase === "speaking") {
        event.preventDefault();
        commanderVoiceChatController.interruptAndListen();
      } else if (voiceChat.phase === "listening" && voiceChat.heardSpeech) {
        event.preventDefault();
        commanderVoiceChatController.sendNow();
      } else if (voiceChat.phase === "paused") {
        event.preventDefault();
        commanderVoiceChatController.togglePause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, voiceChat.phase, voiceChat.heardSpeech]);

  if (!active) return null;

  const isBusy =
    voiceChat.phase === "starting" ||
    voiceChat.phase === "transcribing" ||
    voiceChat.phase === "thinking";
  const level = voiceChat.phase === "listening" ? Math.max(0.12, voiceChat.level) : 0.15;

  const title = (() => {
    switch (voiceChat.phase) {
      case "starting":
        return gt("Connecting mic…");
      case "listening":
        return voiceChat.heardSpeech ? gt("Hearing you…") : gt("Listening");
      case "transcribing":
        return gt("Transcribing…");
      case "thinking":
        return gt("Computer is thinking…");
      case "speaking":
        return gt("Computer is speaking");
      case "paused":
        return gt("Voice Chat paused");
      case "error":
        return gt("Voice Chat issue");
      default:
        return "";
    }
  })();

  const formatHint = (code: VoiceChatHintCode | null): string | null => {
    switch (code) {
      case "opening-mic":
        return gt("Opening microphone…");
      case "listening":
        return gt("Listening. Speak now.");
      case "hearing":
        return gt("Hearing you. Pause to send.");
      case "transcribing":
        return gt("Transcribing your voice…");
      case "thinking":
        return gt("Computer is working…");
      case "speaking":
        return gt("Tap Interrupt or press Space to cut in.");
      case "paused":
        return gt("Paused. Select Talk to resume.");
      case "paused-silence":
        return gt("Paused after silence. Select Talk to resume.");
      case "missed":
        return gt("Did not catch that. Still listening.");
      case "send-failed":
        return gt("Could not send right now. Select Talk to retry.");
      default:
        return null;
    }
  };

  const formatError = (code: VoiceChatErrorCode | null, detail: string | null): string | null => {
    switch (code) {
      case "unsupported":
        return gt("Microphone capture is not supported in this browser.");
      case "permission-denied":
        return gt("Microphone permission was denied. Allow mic access and retry.");
      case "mic-error":
        return detail
          ? gt("Microphone error: {detail}", { detail })
          : gt("Could not access the microphone.");
      case "transcribe-failed":
        return detail
          ? gt("Transcription failed: {detail}", { detail })
          : gt("Transcription failed. Select Talk to retry.");
      default:
        return null;
    }
  };

  const detail =
    formatError(voiceChat.errorCode, voiceChat.errorDetail) ??
    formatHint(voiceChat.hintCode) ??
    voiceChat.lastTranscript;

  return (
    <div
      data-slot="skofo-voice-chat-bar"
      className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border border-primary/30 bg-card/95 px-3 py-2 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          {isBusy ? (
            <Spinner size="sm" />
          ) : voiceChat.phase === "listening" ? (
            <div className="flex h-4 items-center gap-0.5" aria-hidden="true">
              {WAVE_BARS.map((bar) => (
                <span
                  key={bar.id}
                  className="w-0.5 rounded-full bg-primary transition-all duration-75"
                  style={{ height: `${Math.max(4, Math.round(16 * level * bar.weight))}px` }}
                />
              ))}
            </div>
          ) : voiceChat.phase === "speaking" ? (
            <Volume2Icon className="size-4 animate-pulse" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <Text variant="label" truncate>
            {title}
          </Text>
          {detail ? (
            <Text variant="caption" tone="muted" truncate>
              {detail}
            </Text>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {voiceChat.phase === "listening" ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => commanderVoiceChatController.sendNow()}
            >
              <SendHorizontalIcon className="size-3.5" />
              <span>
                <T>Send now</T>
              </span>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => commanderVoiceChatController.togglePause()}
            >
              <PauseIcon className="size-3.5" />
              <span className="hidden sm:inline">
                <T>Pause</T>
              </span>
            </Button>
          </>
        ) : voiceChat.phase === "speaking" ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => commanderVoiceChatController.interruptAndListen()}
          >
            <MicIcon className="size-3.5" />
            <span>
              <T>Interrupt</T>
            </span>
          </Button>
        ) : voiceChat.phase === "paused" || voiceChat.phase === "error" ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            onClick={() => commanderVoiceChatController.togglePause()}
          >
            <MicIcon className="size-3.5" />
            <span>
              <T>Talk</T>
            </span>
          </Button>
        ) : null}

        <Button
          type="button"
          size="xs"
          variant="destructive-outline"
          onClick={() => commanderVoiceChatController.stop()}
          aria-label={gt("End Voice Chat")}
        >
          <PhoneOffIcon className="size-3.5" />
          <span className="hidden sm:inline">
            <T>End</T>
          </span>
        </Button>
      </div>
    </div>
  );
});

export function useCommanderAutoSpeak(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly isCommander: boolean;
  readonly ready: boolean;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly sendMessage: (text: string) => boolean;
}) {
  const prepared = useThreadVoiceSpeechOutput(input.isCommander ? input.environmentId : null);
  const speech = useCommanderSpeechState();
  const threadKey =
    input.environmentId && input.threadId ? `${input.environmentId}:${input.threadId}` : null;
  const seededThreadKeyRef = useRef<string | null>(null);
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  const onVoiceSend = useEffectEvent((text: string) => input.sendMessage(text));

  const latestCompletedAssistant = input.messages.findLast(
    (msg) => msg.role === "assistant" && !msg.streaming && msg.text.trim().length > 0,
  );
  const latestId = latestCompletedAssistant?.id ?? null;
  const latestText = latestCompletedAssistant?.text ?? "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers Computer thread as a live Voice Chat host and handles one-tap sidebar mic launches
  useEffect(() => {
    if (!input.isCommander || threadKey === null || !prepared) return;
    const unregister = commanderVoiceChatController.registerHost(threadKey, {
      prepared,
      sendMessage: (text) => onVoiceSend(text),
    });
    if (consumeCommanderDictation(threadKey)) {
      void commanderVoiceChatController.startForThread(threadKey);
    }
    const unsubDictation = subscribeCommanderDictation((requestedKey) => {
      if (requestedKey === threadKey && consumeCommanderDictation(threadKey)) {
        void commanderVoiceChatController.startForThread(threadKey);
      }
    });
    return () => {
      unsubDictation();
      unregister();
    };
  }, [input.isCommander, threadKey, prepared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks newly completed Computer replies to trigger audio talk-back and Voice Chat turn continuation without replaying history
  useEffect(() => {
    if (!input.isCommander || threadKey === null) {
      seededThreadKeyRef.current = null;
      lastSpokenMessageIdRef.current = null;
      return;
    }
    if (!input.ready) {
      return;
    }
    if (seededThreadKeyRef.current !== threadKey) {
      seededThreadKeyRef.current = threadKey;
      lastSpokenMessageIdRef.current = latestId;
      return;
    }
    if (!latestId || latestId === lastSpokenMessageIdRef.current) {
      return;
    }
    lastSpokenMessageIdRef.current = latestId;
    const voiceChatActive = commanderVoiceChatController.isActiveFor(threadKey);
    if ((!speech.talkBackEnabled && !voiceChatActive) || !prepared) {
      return;
    }
    if (voiceChatActive) {
      commanderVoiceChatController.notifySpeakingStart(threadKey);
    }
    void commanderSpeechController
      .speak({
        prepared,
        text: latestText,
        messageId: latestId,
        mode: "auto",
      })
      .then((outcome) => {
        commanderVoiceChatController.notifySpeakingFinished(threadKey, outcome);
      });
  }, [
    input.isCommander,
    input.ready,
    threadKey,
    latestId,
    latestText,
    speech.talkBackEnabled,
    prepared,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio playback and voice chat when switching away from Computer
  useEffect(() => {
    if (!input.isCommander || threadKey === null) return;
    return () => {
      commanderSpeechController.stop();
      if (commanderVoiceChatController.isActiveFor(threadKey)) {
        commanderVoiceChatController.stop();
      }
    };
  }, [input.isCommander, threadKey]);
}

export const AssistantSpeakButton = memo(function AssistantSpeakButton({
  environmentId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: ChatMessage;
}) {
  const gt = useGT();
  const prepared = useThreadVoiceSpeechOutput(environmentId);
  const speech = useCommanderSpeechState();

  if (!prepared || message.streaming || !message.text.trim()) {
    return null;
  }

  const isThisSpeaking = speech.status !== "idle" && speech.speakingMessageId === message.id;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              if (isThisSpeaking) {
                commanderSpeechController.stop();
                return;
              }
              void commanderSpeechController.speak({
                prepared,
                text: message.text,
                messageId: message.id,
                mode: "full",
              });
            }}
            aria-label={isThisSpeaking ? gt("Stop reading aloud") : gt("Read aloud")}
          />
        }
      >
        {isThisSpeaking ? (
          <SquareIcon className="size-3 fill-current text-primary" />
        ) : (
          <Volume2Icon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{isThisSpeaking ? <T>Stop</T> : <T>Read aloud</T>}</TooltipPopup>
    </Tooltip>
  );
});
