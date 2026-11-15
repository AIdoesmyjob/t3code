import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";
import {
  awaitGatewaySignIn,
  environmentsByGatewayOrigin,
  isGatewaySignInPending,
  probeGateway,
} from "./gatewaySession";

const RECHECK_INTERVAL_MS = 10 * 60 * 1000;

export function openGatewaySignIn(origin: string): void {
  whenRootNavigationReady(() => rootNavigationRef.navigate("GatewaySignIn", { origin }));
}

/**
 * Notices when a gateway session in front of a saved environment has expired (on launch, on
 * return to the foreground, and every ten minutes in it) and offers to sign in again, then
 * reconnects that origin's environments. Asks at most once per origin per foreground visit.
 */
export function GatewaySessionWatcher() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const retry = useRetryEnvironment();
  const asked = useRef(new Set<string>());

  const check = useEffectEvent(async () => {
    const byOrigin = environmentsByGatewayOrigin(Object.values(savedConnectionsById));
    for (const [origin, environmentIds] of byOrigin) {
      if (asked.current.has(origin) || isGatewaySignInPending(origin)) continue;
      if ((await probeGateway(origin)) !== "sign-in-required") continue;
      if (asked.current.has(origin) || isGatewaySignInPending(origin)) continue;
      asked.current.add(origin);
      const host = new URL(origin).host;
      Dialog.alert(
        `Sign in to ${host}`,
        `Your sign-in for ${host} has expired. Sign in again to reconnect.`,
        [
          { text: "Not now", style: "cancel" },
          {
            text: "Sign in",
            onPress: () => {
              const signedIn = awaitGatewaySignIn(origin);
              openGatewaySignIn(origin);
              void signedIn.then((ok) => {
                if (!ok) return;
                asked.current.delete(origin);
                for (const environmentId of environmentIds) void retry(environmentId);
              });
            },
          },
        ],
      );
    }
  });

  const connectionCount = Object.keys(savedConnectionsById).length;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- AppState listener + recheck timer, held while mounted
  useEffect(() => {
    if (connectionCount === 0) return;
    void check();
    let interval: ReturnType<typeof setInterval> | null = setInterval(
      () => void check(),
      RECHECK_INTERVAL_MS,
    );
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        asked.current.clear();
        void check();
        interval ??= setInterval(() => void check(), RECHECK_INTERVAL_MS);
      } else if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    });
    return () => {
      subscription.remove();
      if (interval !== null) clearInterval(interval);
    };
  }, [connectionCount]);

  return null;
}
