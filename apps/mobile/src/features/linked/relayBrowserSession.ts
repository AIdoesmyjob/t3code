import { isRelayBrowserSession } from "./linkedRelay";

const pending = new Map<string, Promise<boolean>>();

async function readSessionState(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.toLowerCase().includes("application/json")) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function signIn(input: {
  readonly hostHttpBaseUrl: string;
  readonly mintCredential: () => Promise<string | null>;
  readonly fetchImpl: typeof fetch;
}): Promise<boolean> {
  const sessionUrl = new URL("/api/auth/session", input.hostHttpBaseUrl).href;
  // Sent without the app's own token, so this reads only the cookie sign-in.
  if (isRelayBrowserSession(await readSessionState(input.fetchImpl, sessionUrl))) return true;
  const credential = await input.mintCredential();
  if (credential === null) return false;
  try {
    const response = await input.fetchImpl(
      new URL("/api/auth/browser-session", input.hostHttpBaseUrl).href,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      },
    );
    if (!response.ok) return false;
  } catch {
    return false;
  }
  return isRelayBrowserSession(await readSessionState(input.fetchImpl, sessionUrl));
}

/**
 * Makes sure the host has a browser sign-in for this app, which its `/linked/<id>/` relay
 * requires. On Android the cookie lands in the store React Native's fetch and WebSocket share,
 * as the gateway sign-in's does. A missing one is made from a one-time code the app mints with
 * its own session there, so it carries the same permissions. One attempt per host at a time.
 */
export function ensureRelayBrowserSession(input: {
  readonly hostHttpBaseUrl: string;
  readonly mintCredential: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const key = new URL(input.hostHttpBaseUrl).origin;
  const running = pending.get(key);
  if (running) return running;
  const attempt = signIn({ ...input, fetchImpl: input.fetchImpl ?? fetch }).finally(() =>
    pending.delete(key),
  );
  pending.set(key, attempt);
  return attempt;
}
