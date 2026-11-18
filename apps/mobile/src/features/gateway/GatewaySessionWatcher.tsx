/* oxlint-disable t3code/no-untranslated-copy -- Skofo fork screen, English only */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
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

function askToSignIn(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.alert(
      `Sign in to ${host}`,
      `Your sign-in for ${host} has expired. Sign in again to reconnect.`,
      [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "Sign in", onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Notices when a gateway session in front of a switched-on environment has expired (on launch,
 * on return to the foreground, and every ten minutes in it) and offers to sign in again, one
 * origin at a time, then reconnects that origin's environments. Asks at most once per origin per
 * foreground visit.
 */
export function GatewaySessionWatcher() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const retryNow = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const asked = useRef(new Set<string>());
  const running = useRef(false);
  // Bumped when the app leaves the foreground or the watcher unmounts; stale checks stop.
  const generation = useRef(0);

  const isEnabled = useEffectEvent(
    (environmentId: EnvironmentId) => catalog.entries.get(environmentId)?.enabled !== false,
  );
  const enabledByOrigin = useEffectEvent(() => {
    const byOrigin = new Map<string, EnvironmentId[]>();
    for (const [origin, ids] of environmentsByGatewayOrigin(Object.values(savedConnectionsById))) {
      const enabled = ids.filter((id) => isEnabled(id));
      if (enabled.length > 0) byOrigin.set(origin, enabled);
    }
    return byOrigin;
  });
  const reconnect = useEffectEvent((environmentIds: ReadonlyArray<EnvironmentId>) => {
    // A sign-in must not switch back on an environment the user turned off meanwhile.
    for (const environmentId of environmentIds) {
      if (isEnabled(environmentId)) void retryNow(environmentId);
    }
  });

  const checkOrigins = useEffectEvent(async (stale: () => boolean) => {
    for (const [origin, environmentIds] of enabledByOrigin()) {
      if (asked.current.has(origin) || isGatewaySignInPending(origin)) continue;
      if ((await probeGateway(origin)) !== "sign-in-required" || stale()) continue;
      if (asked.current.has(origin) || isGatewaySignInPending(origin)) continue;
      asked.current.add(origin);
      // An explicit "Sign in" tap proceeds even if the app was backgrounded meanwhile.
      if (!(await askToSignIn(new URL(origin).host))) continue;
      const signedIn = awaitGatewaySignIn(origin);
      openGatewaySignIn(origin);
      if (!(await signedIn)) continue;
      asked.current.delete(origin);
      reconnect(environmentIds);
    }
  });

  const check = useEffectEvent(() => {
    if (running.current) return;
    running.current = true;
    const started = generation.current;
    void checkOrigins(() => generation.current !== started).finally(() => {
      running.current = false;
    });
  });

  const connectionCount = Object.keys(savedConnectionsById).length;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- AppState listener + recheck timer, held while mounted
  useEffect(() => {
    if (connectionCount === 0) return;
    check();
    let interval: ReturnType<typeof setInterval> | null = setInterval(
      () => check(),
      RECHECK_INTERVAL_MS,
    );
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        asked.current.clear();
        check();
        if (interval === null) interval = setInterval(() => check(), RECHECK_INTERVAL_MS);
      } else {
        generation.current += 1;
        if (interval !== null) clearInterval(interval);
        interval = null;
      }
    });
    return () => {
      generation.current += 1;
      subscription.remove();
      if (interval !== null) clearInterval(interval);
    };
  }, [connectionCount]);

  return null;
}
