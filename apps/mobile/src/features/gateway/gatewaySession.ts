import type { EnvironmentId } from "@t3tools/contracts";

/**
 * A sign-in gateway (skofo: Authelia on t3.skofo.ca) redirects requests without its session to
 * its portal. Android's React Native fetch/WebSocket share the WebView cookie store, so one
 * WebView sign-in lets the app through.
 */

export type GatewayProbe = "open" | "sign-in-required" | "unreachable";

/** Answers JSON (401 without a bearer token) when nothing stands in front of the server. */
export const GATEWAY_PROBE_PATH = "/api/auth/session";
const PROBE_TIMEOUT_MS = 8_000;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Only HTTPS origins can sit behind a cookie gateway; plain-HTTP LAN servers are left alone. */
export function gatewayOriginOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export interface GatewayProbeResponse {
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

export function classifyGatewayResponse(
  requestOrigin: string,
  response: GatewayProbeResponse,
): GatewayProbe {
  const finalOrigin = response.url ? originOf(response.url) : null;
  if (finalOrigin !== null && finalOrigin !== requestOrigin) return "sign-in-required";
  // The environment's API never answers HTML; a portal page means the gateway intercepted.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) return "sign-in-required";
  return "open";
}

export async function probeGateway(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${origin}${GATEWAY_PROBE_PATH}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return classifyGatewayResponse(origin, response);
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

type SignInWaiter = (signedIn: boolean) => void;
const signInWaiters = new Map<string, SignInWaiter[]>();

export function isGatewaySignInPending(origin: string): boolean {
  return signInWaiters.has(origin);
}

/** Resolves when the sign-in screen for `origin` finishes: true once the gateway lets us through. */
export function awaitGatewaySignIn(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const waiters = signInWaiters.get(origin) ?? [];
    waiters.push(resolve);
    signInWaiters.set(origin, waiters);
  });
}

export function settleGatewaySignIn(origin: string, signedIn: boolean): void {
  const waiters = signInWaiters.get(origin) ?? [];
  signInWaiters.delete(origin);
  for (const resolve of waiters) resolve(signedIn);
}

/**
 * Before talking to `url`'s environment, makes sure no gateway is in the way, opening the
 * sign-in screen when one is. Resolves false only when the user left sign-in unfinished. An
 * unreachable server resolves true so the caller reports its own, more specific error.
 */
export async function ensureGatewaySession(
  url: string,
  openSignIn: (origin: string) => void,
  probe: (origin: string) => Promise<GatewayProbe> = probeGateway,
): Promise<boolean> {
  const origin = gatewayOriginOf(url);
  if (origin === null) return true;
  if ((await probe(origin)) !== "sign-in-required") return true;
  const signedIn = awaitGatewaySignIn(origin);
  openSignIn(origin);
  return signedIn;
}

/** Groups saved direct (not relay) environments by the HTTPS origin a gateway would guard. */
export function environmentsByGatewayOrigin(
  connections: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly relayManaged?: true;
  }>,
): Map<string, EnvironmentId[]> {
  const byOrigin = new Map<string, EnvironmentId[]>();
  for (const connection of connections) {
    if (connection.relayManaged) continue;
    const origin = gatewayOriginOf(connection.httpBaseUrl);
    if (origin === null) continue;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), connection.environmentId]);
  }
  return byOrigin;
}
