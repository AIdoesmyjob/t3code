import { describe, expect, it, vi } from "vite-plus/test";

import {
  awaitGatewaySignIn,
  classifyGatewayResponse,
  environmentsByGatewayOrigin,
  ensureGatewaySession,
  gatewayOriginOf,
  isGatewaySignInPending,
  probeGateway,
  settleGatewaySignIn,
} from "./gatewaySession";

const ORIGIN = "https://t3.skofo.ca";

function response(url: string, contentType: string | null) {
  return {
    url,
    headers: { get: (name: string) => (name === "content-type" ? contentType : null) },
  };
}

describe("gatewayOriginOf", () => {
  it("keeps HTTPS origins and drops paths, hashes and plain HTTP", () => {
    expect(gatewayOriginOf("https://t3.skofo.ca/pair#token=abc")).toBe(ORIGIN);
    expect(gatewayOriginOf("https://t3.skofo.ca:8443/x")).toBe("https://t3.skofo.ca:8443");
    expect(gatewayOriginOf("http://10.2.2.236:4141/pair#token=abc")).toBeNull();
    expect(gatewayOriginOf("not a url")).toBeNull();
  });
});

describe("classifyGatewayResponse", () => {
  it("treats a redirect to the portal's origin as needing sign-in", () => {
    expect(
      classifyGatewayResponse(
        ORIGIN,
        response(
          "https://auth.skofo.ca/?rd=https%3A%2F%2Ft3.skofo.ca%2Fapi%2Fauth%2Fsession",
          "text/html",
        ),
      ),
    ).toBe("sign-in-required");
  });

  it("treats same-origin HTML as an intercepting gateway", () => {
    expect(
      classifyGatewayResponse(
        ORIGIN,
        response(`${ORIGIN}/api/auth/session`, "text/html; charset=utf-8"),
      ),
    ).toBe("sign-in-required");
  });

  it("lets the environment's JSON through, even a 401", () => {
    expect(
      classifyGatewayResponse(ORIGIN, response(`${ORIGIN}/api/auth/session`, "application/json")),
    ).toBe("open");
  });

  it("falls back to the content type when the final URL is unknown", () => {
    expect(classifyGatewayResponse(ORIGIN, response("", "application/json"))).toBe("open");
    expect(classifyGatewayResponse(ORIGIN, response("", "text/html"))).toBe("sign-in-required");
  });
});

describe("probeGateway", () => {
  it("asks for the session endpoint with cookies and no cache", async () => {
    const fetchImpl = vi.fn(async () => response(`${ORIGIN}/api/auth/session`, "application/json"));
    await expect(probeGateway(ORIGIN, fetchImpl as unknown as typeof fetch)).resolves.toBe("open");
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ORIGIN}/api/auth/session`,
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("reports a network failure as unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(probeGateway(ORIGIN, fetchImpl as unknown as typeof fetch)).resolves.toBe(
      "unreachable",
    );
  });
});

describe("ensureGatewaySession", () => {
  it("does not open sign-in when the server is open or unreachable", async () => {
    const openSignIn = vi.fn();
    await expect(
      ensureGatewaySession(`${ORIGIN}/pair#token=x`, openSignIn, async () => "open"),
    ).resolves.toBe(true);
    await expect(
      ensureGatewaySession(`${ORIGIN}/pair#token=x`, openSignIn, async () => "unreachable"),
    ).resolves.toBe(true);
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it("skips plain-HTTP servers without probing", async () => {
    const probe = vi.fn(async () => "sign-in-required" as const);
    await expect(ensureGatewaySession("http://10.2.2.236:4141", vi.fn(), probe)).resolves.toBe(
      true,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("opens sign-in for the origin and resolves with its outcome", async () => {
    const openSignIn = vi.fn();
    const pending = ensureGatewaySession(
      `${ORIGIN}/pair#token=x`,
      openSignIn,
      async () => "sign-in-required",
    );
    await vi.waitFor(() => expect(openSignIn).toHaveBeenCalledWith(ORIGIN));
    expect(isGatewaySignInPending(ORIGIN)).toBe(true);
    settleGatewaySignIn(ORIGIN, true);
    await expect(pending).resolves.toBe(true);
    expect(isGatewaySignInPending(ORIGIN)).toBe(false);
  });

  it("resolves false when sign-in is abandoned", async () => {
    const pending = ensureGatewaySession(
      ORIGIN,
      () => settleGatewaySignIn(ORIGIN, false),
      async () => "sign-in-required",
    );
    await expect(pending).resolves.toBe(false);
  });
});

describe("gateway sign-in waiters", () => {
  it("settles every waiter for an origin once, and only that origin", async () => {
    const first = awaitGatewaySignIn(ORIGIN);
    const second = awaitGatewaySignIn(ORIGIN);
    const other = awaitGatewaySignIn("https://other.example");
    settleGatewaySignIn(ORIGIN, true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(isGatewaySignInPending("https://other.example")).toBe(true);
    settleGatewaySignIn("https://other.example", false);
    await expect(other).resolves.toBe(false);
  });
});

describe("environmentsByGatewayOrigin", () => {
  it("groups direct HTTPS environments by origin and skips relay and plain HTTP ones", () => {
    const grouped = environmentsByGatewayOrigin([
      { environmentId: "a" as never, httpBaseUrl: `${ORIGIN}/` },
      { environmentId: "b" as never, httpBaseUrl: `${ORIGIN}` },
      { environmentId: "c" as never, httpBaseUrl: "http://10.2.2.236:4141" },
      { environmentId: "d" as never, httpBaseUrl: "https://relay.example", relayManaged: true },
    ]);
    expect([...grouped.entries()]).toEqual([[ORIGIN, ["a", "b"]]]);
  });
});
