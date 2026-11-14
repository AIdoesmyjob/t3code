import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  linkedEnvironmentRelayPath,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectPairing } from "../connection/onboarding";
import { isElectron } from "../env";
import { useEnvironmentIdentities, useEnvironments, usePrimaryEnvironmentId } from "./environments";
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
 * Adds a linked environment to this browser, the way the desktop app adds a
 * machine over SSH. The linking environment's relay signs in at the peer with
 * its own session, so every browser signed in there gets the same machines and
 * none keeps a sign-in of its own that could go stale.
 */
export function useOpenLinkedEnvironment() {
  const connect = useAtomCommand(connectPairing, {
    label: "connect linked environment",
    reportFailure: false,
  });
  return (linkedEnvironmentId: EnvironmentId): Promise<AtomCommandResult<unknown, unknown>> =>
    connect({
      expectedEnvironmentId: linkedEnvironmentId,
      linkedRelay: linkedRelayBaseUrls(linkedEnvironmentRelayPath(linkedEnvironmentId)),
    });
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

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/**
 * Machines a project folder can be copied between, through the environment
 * serving this page: itself and those it links with full access, when each
 * runs a version that copies projects.
 */
export function useCopyableEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const primary = usePrimaryEnvironmentId();
  const offered = useAtomValue(
    primary === null ? NO_LINKS_ATOM : offersLinkedEnvironmentsAtom(primary),
  );
  const permitted = useAtomValue(
    primary === null ? NO_LINKS_ATOM : peerLinkEnvironment.copyProject.permissionAtom(primary),
  );
  const enabled = linkedRelayAvailable && primary !== null && offered && permitted;
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId: primary, input: {} }) : null,
  );
  const { environments } = useEnvironments();
  if (!enabled) return NO_ENVIRONMENTS;
  const copies = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.linkedProjectCopy === true;
  if (!copies(primary)) return NO_ENVIRONMENTS;
  const ids = new Set<EnvironmentId>([primary]);
  for (const link of links.data?.links ?? []) {
    if (
      link.status === "reachable" &&
      link.access === "full-access" &&
      copies(link.environmentId)
    ) {
      ids.add(link.environmentId);
    }
  }
  return ids;
}
