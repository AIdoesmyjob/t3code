import { useEffect, useState } from "react";

import { subscribeAppActive } from "../../lib/appState";
import { phoneControlNative, type PhoneControlReading } from "../../native/phoneControl";

const REFRESH_MS = 30_000;

function read(): {
  readonly reading: PhoneControlReading | null;
  readonly isAssistant: boolean;
  readonly nowMillis: number;
} {
  return {
    reading: phoneControlNative?.status() ?? null,
    isAssistant: phoneControlNative?.isDefaultAssistant() ?? false,
    nowMillis: Date.now(),
  };
}

/**
 * The companion's status and whether this app is the assistant (chosen in system Settings),
 * refreshed when the companion reports a change, on resume and every 30 s.
 */
export function usePhoneControlReading(): ReturnType<typeof read> & {
  readonly refresh: () => void;
} {
  const [state, setState] = useState(read);
  const refresh = () => setState(read());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the companion's provider, which notifies on change
  useEffect(() => {
    const native = phoneControlNative;
    if (!native) return;
    const update = () => setState(read());
    const subscription = native.addListener("onStatusChange", update);
    const unsubscribeActive = subscribeAppActive(update);
    const interval = setInterval(update, REFRESH_MS);
    return () => {
      subscription.remove();
      unsubscribeActive();
      clearInterval(interval);
    };
  }, []);

  return { ...state, refresh };
}
