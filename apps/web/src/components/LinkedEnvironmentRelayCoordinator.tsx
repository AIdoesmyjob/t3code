import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useOpenLinkedEnvironment, useUnopenedLinkedEnvironments } from "../state/linkedRelay";

/**
 * Adds every linked environment this browser can open through the relay and
 * does not list yet, on every visit, so each browser signed in here shows the
 * same machines in the sidebar and "Run on". A machine leaves every browser
 * when its link is forgotten.
 */
export function LinkedEnvironmentRelayCoordinator() {
  const { hostEnvironmentId, links } = useUnopenedLinkedEnvironments();
  if (hostEnvironmentId === null) return null;
  return links.map((link) => (
    <OpenLinkedEnvironmentOnce key={link.environmentId} environmentId={link.environmentId} />
  ));
}

function OpenLinkedEnvironmentOnce({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const open = useOpenLinkedEnvironment();
  const attempted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one attempt per visit for each linked environment the link list shows unopened
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    // A failure is tried again on the next visit; Settings shows why.
    void open(environmentId);
  }, [environmentId, open]);
  return null;
}
