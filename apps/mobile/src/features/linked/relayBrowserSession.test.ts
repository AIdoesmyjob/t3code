import { describe, expect, it, vi } from "vite-plus/test";

import { ensureRelayBrowserSession } from "./relayBrowserSession";

const HOST = "https://t3.skofo.ca/";
const SIGNED_IN = {
  authenticated: true,
  sessionMethod: "browser-session-cookie",
  scopes: ["access:write"],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The host's session and browser-session endpoints; a redeemed code sets the cookie. */
function fakeHost(initiallySignedIn: boolean) {
  let signedIn = initiallySignedIn;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${HOST}api/auth/session`) {
      return json(signedIn ? SIGNED_IN : { authenticated: false });
    }
    if (url === `${HOST}api/auth/browser-session`) {
      const body = JSON.parse(String(init?.body)) as { credential: string };
      if (body.credential !== "ONE-TIME") return json({ error: "invalid" }, 401);
      signedIn = true;
      return json({ authenticated: true });
    }
    return new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("ensureRelayBrowserSession", () => {
  it("keeps an existing cookie sign-in without minting a code", async () => {
    const host = fakeHost(true);
    const mintCredential = vi.fn(async () => "ONE-TIME");
    await expect(
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential,
        fetchImpl: host.fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(mintCredential).not.toHaveBeenCalled();
    expect(host.calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("redeems a freshly minted code for a cookie sign-in", async () => {
    const host = fakeHost(false);
    await expect(
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential: async () => "ONE-TIME",
        fetchImpl: host.fetchImpl,
      }),
    ).resolves.toBe(true);
    const redeem = host.calls.find((call) => call.url.endsWith("/api/auth/browser-session"));
    expect(redeem?.init?.method).toBe("POST");
    expect(redeem?.init?.credentials).toBe("include");
  });

  it("gives up when no code can be minted or the host refuses it", async () => {
    await expect(
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential: async () => null,
        fetchImpl: fakeHost(false).fetchImpl,
      }),
    ).resolves.toBe(false);
    await expect(
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential: async () => "WRONG",
        fetchImpl: fakeHost(false).fetchImpl,
      }),
    ).resolves.toBe(false);
  });

  it("treats a sign-in page in front of the host as not signed in", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    await expect(
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential: async () => null,
        fetchImpl,
      }),
    ).resolves.toBe(false);
  });

  it("shares one attempt per host", async () => {
    const host = fakeHost(false);
    const mintCredential = vi.fn(async () => "ONE-TIME");
    const [first, second] = await Promise.all([
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential,
        fetchImpl: host.fetchImpl,
      }),
      ensureRelayBrowserSession({
        hostHttpBaseUrl: HOST,
        mintCredential,
        fetchImpl: host.fetchImpl,
      }),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(mintCredential).toHaveBeenCalledTimes(1);
  });
});
