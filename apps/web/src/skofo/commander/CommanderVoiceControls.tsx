import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { T, useGT } from "gt-react";
import { SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useQuietThreadShell } from "~/state/entities";
import type { ChatMessage } from "~/types";
import { isCommanderThread } from "./commanderConstants";
import {
  commanderSpeechController,
  useCommanderSpeechState,
  useThreadVoiceSpeechOutput,
} from "./commanderSpeech";

export const CommanderVoiceHeaderButton = memo(function CommanderVoiceHeaderButton({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const prepared = useThreadVoiceSpeechOutput(environmentId);
  const speech = useCommanderSpeechState();

  if (!prepared || !thread || !isCommanderThread(thread)) {
    return null;
  }

  const isActive = speech.status !== "idle";
  const label = isActive
    ? gt("Stop Computer voice")
    : speech.talkBackEnabled
      ? gt("Mute Computer talk-back")
      : gt("Enable Computer talk-back");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs-pill"
            variant={isActive ? "secondary" : speech.talkBackEnabled ? "info-tint" : "ghost"}
            aria-label={label}
            aria-pressed={speech.talkBackEnabled}
            onClick={() => commanderSpeechController.toggleTalkBack()}
          />
        }
      >
        {isActive ? (
          <SquareIcon className="size-3 fill-current" />
        ) : speech.talkBackEnabled ? (
          <Volume2Icon className="size-3.5" />
        ) : (
          <VolumeXIcon className="size-3.5 text-muted-foreground" />
        )}
        <span className="hidden sm:inline">
          {isActive ? <T>Stop</T> : speech.talkBackEnabled ? <T>Voice on</T> : <T>Voice off</T>}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

export function useCommanderAutoSpeak(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly isCommander: boolean;
  readonly messages: ReadonlyArray<ChatMessage>;
}) {
  const prepared = useThreadVoiceSpeechOutput(input.isCommander ? input.environmentId : null);
  const speech = useCommanderSpeechState();
  const threadKey =
    input.environmentId && input.threadId ? `${input.environmentId}:${input.threadId}` : null;
  const seededThreadKeyRef = useRef<string | null>(null);
  const lastSpokenMessageIdRef = useRef<string | null>(null);

  const latestCompletedAssistant = input.messages.findLast(
    (msg) => msg.role === "assistant" && !msg.streaming && msg.text.trim().length > 0,
  );
  const latestId = latestCompletedAssistant?.id ?? null;
  const latestText = latestCompletedAssistant?.text ?? "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks newly completed Computer replies to trigger audio talk-back without replaying history
  useEffect(() => {
    if (!input.isCommander || threadKey === null) {
      seededThreadKeyRef.current = null;
      lastSpokenMessageIdRef.current = null;
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
    if (!speech.talkBackEnabled || !prepared) {
      return;
    }
    void commanderSpeechController.speak({
      prepared,
      text: latestText,
      messageId: latestId,
    });
  }, [input.isCommander, threadKey, latestId, latestText, speech.talkBackEnabled, prepared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio playback when switching away from Computer
  useEffect(() => {
    if (!input.isCommander || threadKey === null) return;
    return () => {
      commanderSpeechController.stop();
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
