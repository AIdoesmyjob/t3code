import { useEffect, useEffectEvent, useRef, useState } from "react";

import { subscribeAppActive } from "../../lib/appState";
import { phoneControlNative, type PhoneControlReading } from "../../native/phoneControl";

const REFRESH_MS = 30_000;

interface PhoneControlSnapshot {
  readonly reading: PhoneControlReading | null;
  readonly isAssistant: boolean;
  readonly nowMillis: number;
}

const INITIAL: PhoneControlSnapshot = { reading: null, isAssistant: false, nowMillis: 0 };

async function read(): Promise<PhoneControlSnapshot> {
  const native = phoneControlNative;
  if (!native) return { ...INITIAL, nowMillis: Date.now() };
  const [reading, isAssistant] = await Promise.all([native.status(), native.isDefaultAssistant()]);
  return { reading, isAssistant, nowMillis: Date.now() };
}

/**
 * The companion's status and whether this app is the assistant (chosen in system Settings),
 * read off the JS thread when the companion reports a change, on resume and every 30 s. A
 * slower, older read never replaces a newer one.
 */
export function usePhoneControlReading(): PhoneControlSnapshot & {
  readonly loaded: boolean;
  readonly refresh: () => void;
} {
  const [state, setState] = useState<PhoneControlSnapshot>(INITIAL);
  const latest = useRef(0);
  const refresh = () => {
    latest.current += 1;
    const request = latest.current;
    void read().then(
      (next) => {
        if (request === latest.current) setState(next);
      },
      (error: unknown) => console.warn("[phone-control] status read failed", error),
    );
  };

  const update = useEffectEvent(() => refresh());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the companion's provider, which notifies on change
  useEffect(() => {
    const native = phoneControlNative;
    if (!native) return;
    update();
    const subscription = native.addListener("onStatusChange", update);
    const unsubscribeActive = subscribeAppActive(update);
    const interval = setInterval(update, REFRESH_MS);
    return () => {
      latest.current += 1;
      subscription.remove();
      unsubscribeActive();
      clearInterval(interval);
    };
  }, []);

  return { ...state, loaded: state.nowMillis > 0, refresh };
}
