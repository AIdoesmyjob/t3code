import {
  AuthAccessWriteScope,
  type EnvironmentId,
  linkedEnvironmentRelayPath,
  type PeerLinkSummary,
} from "@t3tools/contracts";

import { gatewayOriginOf } from "../gateway/gatewaySession";

/** A linked machine's relay bases on its host's origin (`/linked/<id>/`), as the web app uses. */
export function linkedRelayBaseUrls(hostHttpBaseUrl: string, linkedEnvironmentId: EnvironmentId) {
  const http = new URL(linkedEnvironmentRelayPath(linkedEnvironmentId), hostHttpBaseUrl);
  const ws = new URL(http);
  ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  return { httpBaseUrl: http.href, wsBaseUrl: ws.href };
}

/**
 * A host whose links the app can open: reached directly over HTTPS, not through T3 Connect and
 * not itself a machine behind another host's relay.
 */
export function isLinkHost(connection: {
  readonly httpBaseUrl: string;
  readonly relayManaged?: true;
}): boolean {
  if (connection.relayManaged === true || gatewayOriginOf(connection.httpBaseUrl) === null) {
    return false;
  }
  return !new URL(connection.httpBaseUrl).pathname.startsWith("/linked/");
}

/** The host's relay only opens full-access links to peers that answer and offer it. */
export const canOpenThroughRelay = (link: PeerLinkSummary): boolean =>
  link.browserRelay === true && link.status === "reachable";

/** The host's relay accepts only its own browser sign-in, with access management. */
export function isRelayBrowserSession(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  const session = state as {
    readonly authenticated?: unknown;
    readonly sessionMethod?: unknown;
    readonly scopes?: unknown;
  };
  return (
    session.authenticated === true &&
    session.sessionMethod === "browser-session-cookie" &&
    Array.isArray(session.scopes) &&
    session.scopes.includes(AuthAccessWriteScope)
  );
}
