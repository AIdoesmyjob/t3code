import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { connectLinkedEnvironment } from "../../connection/onboarding";
import type { SavedRemoteConnection } from "../../lib/connection";
import { appAtomRegistry } from "../../state/atom-registry";
import { authEnvironment } from "../../state/auth";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { canOpenThroughRelay, isLinkHost, linkedRelayBaseUrls } from "./linkedRelay";
import { ensureRelayBrowserSession } from "./relayBrowserSession";

const BROWSER_SIGN_IN_LABEL = "Skofo T3 app: linked machines";

async function mintBrowserCredential(hostEnvironmentId: EnvironmentId): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    authEnvironment.createPairingCredential,
    { environmentId: hostEnvironmentId, input: { label: BROWSER_SIGN_IN_LABEL } },
    { reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? result.value.credential : null;
}

/**
 * Adds every machine a connected host links with full access, through that host's
 * `/linked/<id>/` relay, the way the web app served by the host does. The phone then shows the
 * same machines as the browser, with no address or sign-in of their own.
 */
export function LinkedMachinesCoordinator() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { environments } = useEnvironments();
  const known = new Set(environments.map((environment) => environment.environmentId));
  const hosts = Object.values(savedConnectionsById).filter(
    (connection) =>
      isLinkHost(connection) &&
      offersLinkedEnvironments(
        environments.find((environment) => environment.environmentId === connection.environmentId)
          ?.serverConfig,
      ),
  );
  return hosts.map((host) => (
    <HostLinkedMachines key={host.environmentId} host={host} known={known} />
  ));
}

function HostLinkedMachines(props: {
  readonly host: SavedRemoteConnection;
  readonly known: ReadonlySet<EnvironmentId>;
}) {
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: props.host.environmentId, input: {} }),
  );
  return (links.data?.links ?? [])
    .filter((link) => canOpenThroughRelay(link) && !props.known.has(link.environmentId))
    .map((link) => (
      <OpenLinkedMachineOnce
        key={link.environmentId}
        host={props.host}
        environmentId={link.environmentId}
      />
    ));
}

function OpenLinkedMachineOnce(props: {
  readonly host: SavedRemoteConnection;
  readonly environmentId: EnvironmentId;
}) {
  const connect = useAtomCommand(connectLinkedEnvironment, {
    label: "connect linked machine",
    reportFailure: false,
  });
  const attempted = useRef(false);
  const { host, environmentId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one attempt per app visit for each linked machine the host lists and the app has not added
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void (async () => {
      const signedIn = await ensureRelayBrowserSession({
        hostHttpBaseUrl: host.httpBaseUrl,
        mintCredential: () => mintBrowserCredential(host.environmentId),
      });
      if (!signedIn) {
        console.warn("[linked-machines] no browser sign-in on", new URL(host.httpBaseUrl).host);
        return;
      }
      await connect({
        expectedEnvironmentId: environmentId,
        linkedRelay: linkedRelayBaseUrls(host.httpBaseUrl, environmentId),
      });
    })();
  }, [connect, environmentId, host]);
  return null;
}
