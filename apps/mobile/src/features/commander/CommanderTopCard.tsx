import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadHasUnseenCompletion } from "../threads/threadListV2";
import {
  isMobileCommanderWorking,
  type MobileCommanderStats,
  requestMobileCommanderDictation,
} from "./commander";
import { mobileCommanderSpeech } from "./mobileCommanderSpeech";

export interface CommanderTopCardProps {
  readonly thread: EnvironmentThreadShell;
  readonly stats: MobileCommanderStats;
  readonly selected: boolean;
  readonly horizontalPadding?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}

export function CommanderTopCard({
  thread,
  stats,
  selected,
  horizontalPadding = 12,
  onSelectThread,
}: CommanderTopCardProps) {
  const gt = useGT();
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const working = isMobileCommanderWorking(thread);
  const unread = !selected && threadHasUnseenCompletion(thread);

  const subtitle = (() => {
    if (working) return gt("Working...");
    if (stats.blocked > 0) return gt("{count} waiting", { count: stats.blocked });
    if (stats.failed > 0) return gt("{count} failed", { count: stats.failed });
    if (stats.working > 0) return gt("{count} working", { count: stats.working });
    if (stats.active > 0) return gt("{count} active", { count: stats.active });
    return gt("Ready");
  })();

  const dotClassName = working
    ? "bg-primary"
    : stats.blocked > 0
      ? "bg-amber-500"
      : stats.failed > 0
        ? "bg-danger"
        : unread
          ? "bg-sky-500"
          : "bg-emerald-500";

  const computerName = gt("Computer", { $context: "name of the persistent top-level agent" });

  const handleVoicePress = () => {
    mobileCommanderSpeech.stop();
    mobileCommanderSpeech.setTalkBackEnabled(true);
    requestMobileCommanderDictation(threadKey);
    onSelectThread(thread);
  };

  return (
    <View style={{ paddingHorizontal: horizontalPadding, paddingTop: 8, paddingBottom: 4 }}>
      <View
        className={cn(
          "flex-row items-center rounded-2xl border px-3 py-2",
          selected ? "border-primary/40 bg-primary/10" : "border-border bg-card",
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Open Computer, {status}", { status: subtitle })}
          onPress={() => onSelectThread(thread)}
          className="flex-1 flex-row items-center gap-3 active:opacity-80"
        >
          <View className="relative h-9 w-9 items-center justify-center rounded-xl bg-primary/15">
            <SymbolView name="robot" size={18} tintColorClassName="accent-primary" />
            <View
              className={cn(
                "absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-card",
                dotClassName,
              )}
            />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[15px] font-t3-semibold text-foreground" numberOfLines={1}>
                {computerName}
              </Text>
              {unread ? <View className="h-2 w-2 rounded-full bg-sky-500" /> : null}
            </View>
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Talk to Computer")}
          hitSlop={6}
          onPress={handleVoicePress}
          className="ml-2 h-11 w-11 items-center justify-center rounded-xl bg-primary/12 active:opacity-75"
        >
          <SymbolView name="mic" size={18} tintColorClassName="accent-primary" />
        </Pressable>
      </View>
    </View>
  );
}
