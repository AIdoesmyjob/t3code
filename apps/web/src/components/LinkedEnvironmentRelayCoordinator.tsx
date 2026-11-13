import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useOpenLinkedEnvironment, useUnopenedLinkedEnvironments } from "../state/linkedRelay";

const OPENED_KEY_PREFIX = "t3code:linked-relay:opened:";

function wasOpenedBefore(environmentId: EnvironmentId): boolean {
  try {
    return window.localStorage.getItem(`${OPENED_KEY_PREFIX}${environmentId}`) !== null;
  } catch {
    return false;
  }
}

function rememberOpened(environmentId: EnvironmentId): void {
  try {
    window.localStorage.setItem(`${OPENED_KEY_PREFIX}${environmentId}`, new Date().toISOString());
  } catch {
    // Without storage the browser may offer it again on a later visit; Settings can remove it.
  }
}

/**
 * Adds each linked environment this browser can open through the relay, once
 * per browser, so it appears in the sidebar and "Run on" like a machine added
 * by hand. One removed in Settings stays removed; Settings can open it again.
 */
export function LinkedEnvironmentRelayCoordinator() {
  const { hostEnvironmentId, links } = useUnopenedLinkedEnvironments();
  if (hostEnvironmentId === null) return null;
  return links.map((link) =>
    wasOpenedBefore(link.environmentId) ? null : (
      <OpenLinkedEnvironmentOnce
        key={link.environmentId}
        hostEnvironmentId={hostEnvironmentId}
        environmentId={link.environmentId}
      />
    ),
  );
}

function OpenLinkedEnvironmentOnce({
  hostEnvironmentId,
  environmentId,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
}) {
  const open = useOpenLinkedEnvironment(hostEnvironmentId);
  const attempted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-time sign-in per linked environment, started when the link list first shows it unopened
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void open(environmentId).then((result) => {
      // A failure is retried on the next visit; Settings shows why.
      if (result._tag === "Success") rememberOpened(environmentId);
    });
  }, [environmentId, open]);
  return null;
}
