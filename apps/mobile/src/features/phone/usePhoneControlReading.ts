import { useEffect, useState } from "react";

import { subscribeAppActive } from "../../lib/appState";
import { phoneControlNative, type PhoneControlReading } from "../../native/phoneControl";

const REFRESH_MS = 30_000;

function read(): PhoneControlReading | null {
  return phoneControlNative?.status() ?? null;
}

/** The companion's status, refreshed when it reports a change, on resume and every 30 s. */
export function usePhoneControlReading(): {
  readonly reading: PhoneControlReading | null;
  readonly nowMillis: number;
  readonly refresh: () => void;
} {
  const [state, setState] = useState(() => ({ reading: read(), nowMillis: Date.now() }));
  const refresh = () => setState({ reading: read(), nowMillis: Date.now() });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the companion's provider, which notifies on change
  useEffect(() => {
    const native = phoneControlNative;
    if (!native) return;
    const update = () => setState({ reading: read(), nowMillis: Date.now() });
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
