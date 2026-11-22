import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  mobileCommanderVoiceChat,
  useMobileCommanderVoiceChatState,
  type MobileVoiceChatErrorCode,
  type MobileVoiceChatHintCode,
} from "./mobileCommanderVoiceChat";

const WAVE_BARS = [
  { id: "b1", weight: 0.45 },
  { id: "b2", weight: 0.85 },
  { id: "b3", weight: 1.0 },
  { id: "b4", weight: 0.7 },
  { id: "b5", weight: 0.5 },
] as const;

export function MobileCommanderVoiceChatBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isCommander: boolean;
  readonly maxWidth: number | undefined;
}) {
  const gt = useGT();
  const voiceChat = useMobileCommanderVoiceChatState();
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  if (!props.isCommander || voiceChat.activeThreadKey !== threadKey || voiceChat.phase === "off") {
    return null;
  }

  const isBusy =
    voiceChat.phase === "starting" ||
    voiceChat.phase === "transcribing" ||
    voiceChat.phase === "thinking";
  const level = voiceChat.phase === "listening" ? Math.max(0.15, voiceChat.level) : 0.15;

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

  const formatHint = (code: MobileVoiceChatHintCode | null): string | null => {
    switch (code) {
      case "requesting-mic":
        return gt("Requesting microphone…");
      case "listening":
        return gt("Listening. Speak now.");
      case "hearing":
        return gt("Hearing you. Pause to send.");
      case "transcribing":
        return gt("Transcribing your voice…");
      case "thinking":
        return gt("Computer is working…");
      case "speaking":
        return gt("Tap Interrupt to cut in.");
      case "paused":
        return gt("Paused. Tap Talk to resume.");
      case "paused-silence":
        return gt("Paused after silence. Tap Talk to resume.");
      case "missed":
        return gt("Did not catch that. Still listening.");
      case "send-failed":
        return gt("Could not send right now. Tap Talk to retry.");
      default:
        return null;
    }
  };

  const formatError = (
    code: MobileVoiceChatErrorCode | null,
    detail: string | null,
  ): string | null => {
    switch (code) {
      case "permission-denied":
        return gt("Microphone permission is required for Voice Chat.");
      case "mic-error":
        return detail
          ? gt("Microphone error: {detail}", { detail })
          : gt("Could not access the microphone.");
      case "transcribe-failed":
        return detail
          ? gt("Transcription failed: {detail}", { detail })
          : gt("Transcription failed. Tap Talk to retry.");
      default:
        return null;
    }
  };

  const detail =
    formatError(voiceChat.errorCode, voiceChat.errorDetail) ??
    formatHint(voiceChat.hintCode) ??
    voiceChat.lastTranscript;

  return (
    <View
      className="self-center px-3 pb-2"
      style={
        props.maxWidth === undefined
          ? { width: "100%" }
          : { width: "100%", maxWidth: props.maxWidth }
      }
    >
      <View className="flex-row items-center justify-between gap-2.5 rounded-2xl border border-primary/35 bg-card px-3 py-2.5">
        <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
          <View className="h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15">
            {isBusy ? (
              <AppActivityIndicator size="small" />
            ) : voiceChat.phase === "listening" ? (
              <View className="h-4 flex-row items-center gap-[2px]">
                {WAVE_BARS.map((bar) => (
                  <View
                    key={bar.id}
                    className="w-[3px] rounded-full bg-primary"
                    style={{ height: Math.max(4, Math.round(16 * level * bar.weight)) }}
                  />
                ))}
              </View>
            ) : voiceChat.phase === "speaking" ? (
              <SymbolView name="speaker.wave.2" size={18} tintColorClassName="accent-primary" />
            ) : (
              <SymbolView name="mic" size={18} tintColorClassName="accent-primary" />
            )}
          </View>

          <View className="min-w-0 flex-1">
            <Text className="text-[14px] font-t3-semibold text-foreground" numberOfLines={1}>
              {title}
            </Text>
            {detail ? (
              <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>

        <View className="shrink-0 flex-row items-center gap-1.5">
          {voiceChat.phase === "listening" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Send voice message now")}
                onPress={() => {
                  void Haptics.selectionAsync();
                  mobileCommanderVoiceChat.sendNow();
                }}
                className="h-9 flex-row items-center gap-1 rounded-xl bg-primary px-3 active:opacity-80"
              >
                <Text className="text-xs font-t3-semibold text-primary-foreground">
                  {gt("Send")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Pause Voice Chat")}
                onPress={() => {
                  void Haptics.selectionAsync();
                  mobileCommanderVoiceChat.togglePause();
                }}
                className="h-9 w-9 items-center justify-center rounded-xl bg-subtle-strong active:opacity-80"
              >
                <SymbolView name="pause" size={15} tintColorClassName="accent-foreground" />
              </Pressable>
            </>
          ) : voiceChat.phase === "speaking" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Interrupt Computer and talk")}
              onPress={() => {
                void Haptics.selectionAsync();
                mobileCommanderVoiceChat.interruptAndListen();
              }}
              className="h-9 flex-row items-center gap-1 rounded-xl bg-subtle-strong px-3 active:opacity-80"
            >
              <SymbolView name="mic" size={14} tintColorClassName="accent-foreground" />
              <Text className="text-xs font-t3-semibold text-foreground">{gt("Interrupt")}</Text>
            </Pressable>
          ) : voiceChat.phase === "paused" || voiceChat.phase === "error" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Resume talking to Computer")}
              onPress={() => {
                void Haptics.selectionAsync();
                mobileCommanderVoiceChat.togglePause();
              }}
              className="h-9 flex-row items-center gap-1 rounded-xl bg-primary px-3 active:opacity-80"
            >
              <SymbolView name="mic" size={14} tintColorClassName="accent-primary-foreground" />
              <Text className="text-xs font-t3-semibold text-primary-foreground">{gt("Talk")}</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("End Voice Chat")}
            onPress={() => {
              void Haptics.selectionAsync();
              mobileCommanderVoiceChat.stop();
            }}
            className="h-9 w-9 items-center justify-center rounded-xl bg-danger/15 active:opacity-80"
          >
            <SymbolView name="xmark" size={15} tintColorClassName="accent-danger" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
