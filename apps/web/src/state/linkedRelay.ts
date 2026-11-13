import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectPairing } from "../connection/onboarding";
import { isElectron } from "../env";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "./environments";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "./peerLinks";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

/**
 * A linked environment opens in this browser through the relay at
 * `/linked/<id>/` on the page's own origin. The relay checks this page's
 * cookie session, so only the web app served by the linking environment
 * itself can use it.
 */
const NO_LINKS_ATOM = Atom.make(false).pipe(Atom.withLabel("linked-relay:none"));

const linkedRelayAvailable = !isElectron && typeof window !== "undefined";

/** The relay's bases on this page's origin. */
function linkedRelayBaseUrls(relayPath: string) {
  const http = new URL(relayPath, window.location.origin);
  const ws = new URL(http);
  ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  return { httpBaseUrl: http.href, wsBaseUrl: ws.href };
}

/**
 * Signs this browser in to a linked environment and adds it, the way the
 * desktop app adds a machine over SSH: the linking environment asks the peer
 * for a one-time code, and the browser redeems it through the relay.
 */
export function useOpenLinkedEnvironment(hostEnvironmentId: EnvironmentId) {
  const pair = useAtomCommand(peerLinkEnvironment.browserPairing, {
    label: "open linked environment",
    reportFailure: false,
  });
  const connect = useAtomCommand(connectPairing, {
    label: "connect linked environment",
    reportFailure: false,
  });
  return async (
    linkedEnvironmentId: EnvironmentId,
  ): Promise<AtomCommandResult<unknown, unknown>> => {
    const issued = await pair({
      environmentId: hostEnvironmentId,
      input: { environmentId: linkedEnvironmentId },
    });
    if (issued._tag === "Failure") return issued;
    return connect({
      expectedEnvironmentId: linkedEnvironmentId,
      linkedRelay: {
        ...linkedRelayBaseUrls(issued.value.relayPath),
        credential: issued.value.credential,
      },
    });
  };
}

/** Whether `link` can be opened in this browser now. */
export const canOpenLinkedEnvironment = (link: PeerLinkSummary) =>
  linkedRelayAvailable && link.browserRelay === true && link.status === "reachable";

/**
 * The primary environment's links this browser could open but has not added,
 * while it may ask for browser sign-ins there.
 */
export function useUnopenedLinkedEnvironments(): {
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly links: ReadonlyArray<PeerLinkSummary>;
} {
  const primary = usePrimaryEnvironmentId();
  const offered = useAtomValue(
    primary === null ? NO_LINKS_ATOM : offersLinkedEnvironmentsAtom(primary),
  );
  const permitted = useAtomValue(
    primary === null ? NO_LINKS_ATOM : peerLinkEnvironment.browserPairing.permissionAtom(primary),
  );
  const enabled = linkedRelayAvailable && primary !== null && offered && permitted;
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId: primary, input: {} }) : null,
  );
  const identities = useEnvironmentIdentities();
  if (!enabled) return { hostEnvironmentId: null, links: [] };
  const known = new Set(identities.map((identity) => identity.environmentId));
  return {
    hostEnvironmentId: primary,
    links: (links.data?.links ?? []).filter(
      (link) => canOpenLinkedEnvironment(link) && !known.has(link.environmentId),
    ),
  };
}
