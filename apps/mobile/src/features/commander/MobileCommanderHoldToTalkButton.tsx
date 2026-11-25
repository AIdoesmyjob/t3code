import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { mobileCommanderVoiceChat } from "./mobileCommanderVoiceChat";

export function MobileCommanderHoldToTalkButton(props: {
  readonly threadKey: string;
  readonly large: boolean;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const { scale } = useAndroidControlSizing();
  const { threadKey } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- release the held mic if its composer disappears
  useEffect(() => () => mobileCommanderVoiceChat.finishHold(threadKey, false), [threadKey]);
  const start = () => void mobileCommanderVoiceChat.startForThread(props.threadKey, "hold");
  const release = () => mobileCommanderVoiceChat.finishHold(threadKey, !props.disabled);
  const activate = () => {
    if (props.disabled) return;
    const voice = mobileCommanderVoiceChat.getSnapshot();
    if (
      voice.activeThreadKey === props.threadKey &&
      voice.inputMode === "hold" &&
      (voice.phase === "starting" || voice.phase === "listening")
    ) {
      release();
    } else {
      start();
    }
  };

  return (
    <View
      accessible
      accessibilityLabel={gt("Hold to talk to Computer")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate") activate();
      }}
      onAccessibilityTap={activate}
      onStartShouldSetResponder={() => !props.disabled}
      onResponderGrant={start}
      onResponderRelease={release}
      onResponderTerminate={() => mobileCommanderVoiceChat.finishHold(props.threadKey, false)}
      className="size-[44px] shrink-0 items-center justify-center"
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      <SymbolView
        name="mic"
        size={Math.round((props.large ? 24 : 20) * scale)}
        tintColorClassName="accent-foreground"
      />
    </View>
  );
}
