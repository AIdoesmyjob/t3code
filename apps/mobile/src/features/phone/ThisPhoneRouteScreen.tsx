import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { phoneControlNative } from "../../native/phoneControl";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { summarizeThisPhone } from "./thisPhonePresentation";
import { usePhoneControlReading } from "./usePhoneControlReading";

/**
 * The phone-control companion on this phone: what agents are doing with it, a Stop that works
 * like the pill's Stop, and the long-press-power assistant setting. Resuming stays in the
 * companion's own screen; this app can only stop.
 */
export function ThisPhoneRouteScreen() {
  const insets = useSafeAreaInsets();
  const { reading, nowMillis, isAssistant, loaded, refresh } = usePhoneControlReading();
  const summary = loaded
    ? summarizeThisPhone(reading, nowMillis)
    : ({ kind: "missing", message: "Checking phone control…" } as const);

  const confirmStop = () => {
    Dialog.confirm({
      title: "Stop phone control?",
      message:
        "Agents lose control of this phone right away, including anything running now. To allow them again, open phone-control on this phone.",
      confirmText: "Stop",
      destructive: true,
      onConfirm: () => {
        const native = phoneControlNative;
        if (!native) return;
        const notAnswered = () =>
          Dialog.alert(
            "Phone control didn't answer",
            "Open phone-control and press Pause there, or use Stop on its pill.",
          );
        void native.pause().then((result) => {
          refresh();
          if (!result.reachable) notAnswered();
        }, notAnswered);
      },
    });
  };

  return (
    <SettingsScreen title="This phone">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Phone control"
          footer={
            summary.kind === "ready"
              ? `${summary.headline} · phone-control ${reading?.status?.companionVersion ?? ""}`
              : undefined
          }
        >
          {summary.kind === "ready" ? (
            summary.rows.map((row) => (
              <ListRowLayout
                key={row.id}
                icon={row.icon}
                label={row.label}
                description={row.value}
              />
            ))
          ) : (
            <View className="px-4 py-4">
              <Text className="text-sm text-foreground-muted">{summary.message}</Text>
            </View>
          )}
        </SettingsSection>

        {summary.kind === "missing" ? null : (
          <SettingsSection title="Actions">
            <ListActionRow
              icon="stop.fill"
              label="Stop phone control"
              tone="danger"
              disabled={summary.kind === "ready" && reading?.status?.paused === true}
              onPress={confirmStop}
            />
            <ListActionRow
              icon="iphone"
              label="Open phone-control"
              onPress={() => {
                if (!phoneControlNative?.openCompanion()) {
                  Dialog.alert("Couldn't open phone-control", "Open it from the app drawer.");
                }
              }}
            />
          </SettingsSection>
        )}

        <View className="gap-3">
          <SettingsSection title="Long-press power">
            <ListActionRow
              icon="mic"
              label={isAssistant ? "Skofo T3 is your assistant" : "Make Skofo T3 your assistant"}
              onPress={() => {
                if (!phoneControlNative?.openAssistantSettings()) {
                  Dialog.alert("Couldn't open settings", "Open Settings › Apps › Default apps.");
                }
              }}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Hold the power button, say what you need, and it starts a new task that begins “On my
            phone:”. Choose Skofo T3 under Default apps › Digital assistant app, and set the power
            button’s press-and-hold action to the assistant (on ColorOS: Settings › Additional
            settings › Power button).
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
