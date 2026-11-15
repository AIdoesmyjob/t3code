import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { GATEWAY_PROBE_PATH, probeGateway, settleGatewaySignIn } from "./gatewaySession";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Shows the gateway's own sign-in page. Its session cookie lands in the WebView cookie store,
 * which the app's fetch and WebSocket share on Android. Done once the WebView is back on the
 * environment's origin and a probe gets through.
 */
export function GatewaySignInRouteScreen({
  route,
}: StaticScreenProps<{ readonly origin: string }>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const origin = route.params.origin;
  const host = originOf(origin) === null ? origin : new URL(origin).host;
  const settled = useRef(false);
  const [checking, setChecking] = useState(false);

  const finish = (signedIn: boolean) => {
    if (settled.current) return;
    settled.current = true;
    settleGatewaySignIn(origin, signedIn);
    if (signedIn && navigation.canGoBack()) navigation.goBack();
  };

  // Leaving the screen any other way counts as an unfinished sign-in.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the pending sign-in waiter registry entry on unmount
  useEffect(
    () => () => {
      if (!settled.current) {
        settled.current = true;
        settleGatewaySignIn(origin, false);
      }
    },
    [origin],
  );

  const handleNavigationStateChange = async (state: WebViewNavigation) => {
    if (state.loading || settled.current) return;
    // Still on the portal (or between its pages).
    if (originOf(state.url) !== origin) return;
    setChecking(true);
    const probe = await probeGateway(origin);
    setChecking(false);
    if (probe === "open") finish(true);
  };

  return (
    <View className="flex-1 bg-screen">
      <View className="gap-1 px-4 pb-3" style={{ paddingTop: insets.top + 12 }}>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-base font-medium text-foreground">Sign in to {host}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              if (navigation.canGoBack()) navigation.goBack();
            }}
          >
            <Text className="text-base text-foreground">Cancel</Text>
          </Pressable>
        </View>
        <Text className="text-sm text-foreground-muted">
          This server sits behind a sign-in page. Sign in once and the app keeps the session until
          it expires.
        </Text>
      </View>
      <View className="flex-1">
        <WebView
          source={{ uri: `${origin}${GATEWAY_PROBE_PATH}` }}
          onNavigationStateChange={(state) => {
            void handleNavigationStateChange(state);
          }}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          setSupportMultipleWindows={false}
          startInLoadingState
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center">
              <AppActivityIndicator />
            </View>
          )}
        />
        {checking ? (
          <View className="absolute inset-0 items-center justify-center bg-screen/70">
            <AppActivityIndicator />
          </View>
        ) : null}
      </View>
    </View>
  );
}
