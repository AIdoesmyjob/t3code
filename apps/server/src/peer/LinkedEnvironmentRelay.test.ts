import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentId,
  PeerLinkError,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as LinkedEnvironmentRelay from "./LinkedEnvironmentRelay.ts";
import * as PeerLinks from "./PeerLinks.ts";

const PEER = EnvironmentId.make("peer-env");

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

interface FixtureOptions {
  readonly session?: {
    readonly method: ServerAuthSessionMethod;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  } | null;
  readonly linkError?: PeerLinkError;
  readonly upstream?: (request: Request) => Response;
}

const fixture = (options: FixtureOptions = {}) => {
  const session =
    options.session === undefined
      ? { method: "browser-session-cookie" as const, scopes: [AuthAccessWriteScope] }
      : options.session;
  const forwarded: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      forwarded.push({ url: request.url, headers: request.headers });
      const response = options.upstream?.(new Request(request.url)) ?? new Response("peer");
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    LinkedEnvironmentRelay.layer.pipe(
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            session === null
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("browser"),
                  subject: "owner",
                  method: session.method,
                  scopes: session.scopes,
                }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(PeerLinks.PeerLinks)({
          relayOrigin: (environmentId) =>
            options.linkError !== undefined
              ? Effect.fail(options.linkError)
              : environmentId === PEER
                ? Effect.succeed("http://127.0.0.1:4241")
                : Effect.fail(new PeerLinkError({ reason: "unknown_link", message: "not linked" })),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, forwarded };
};

const relayed = (path: string, init?: RequestInit) =>
  new Request(`https://t3.test/linked/${PEER}${path}`, init);

describe("linked environment relay", () => {
  it("forwards the peer path with the browser's peer sign-in but none of this server's", async () => {
    const { handler, forwarded } = fixture({
      upstream: () =>
        new Response("ok", { headers: { "set-cookie": "t3_session=peer", "x-peer": "1" } }),
    });
    const response = await handler(
      relayed("/api/auth/session?x=1", {
        headers: {
          authorization: "Bearer peer-token",
          cookie: "t3_session_abc=primary",
          "x-forwarded-host": "t3.test",
          "remote-user": "lukas",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-peer")).toBe("1");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.url).toBe("http://127.0.0.1:4241/api/auth/session?x=1");
    expect(forwarded[0]!.headers.authorization).toBe("Bearer peer-token");
    expect(forwarded[0]!.headers.cookie).toBeUndefined();
    expect(forwarded[0]!.headers["x-forwarded-host"]).toBeUndefined();
    expect(forwarded[0]!.headers["remote-user"]).toBeUndefined();
    expect(forwarded[0]!.headers["accept-encoding"]).toBe("identity");
  });

  it("refuses a browser without a session cookie here", async () => {
    const { handler, forwarded } = fixture({ session: null });
    const response = await handler(relayed("/api/auth/session"));
    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a bearer client, whose Authorization would be this server's", async () => {
    const { handler, forwarded } = fixture({
      session: { method: "bearer-access-token", scopes: [AuthAccessWriteScope] },
    });
    expect((await handler(relayed("/api/auth/session"))).status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a session that may not manage access", async () => {
    const { handler, forwarded } = fixture({
      session: { method: "browser-session-cookie", scopes: [AuthOrchestrationReadScope] },
    });
    expect((await handler(relayed("/api/auth/session"))).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it.each(["/mcp", "/", "/pair", "/api/peer/browser-pairing", "/oauth/mcp/token"])(
    "keeps %s on the peer closed",
    async (path) => {
      const { handler, forwarded } = fixture();
      expect((await handler(relayed(path))).status).toBe(404);
      expect(forwarded).toHaveLength(0);
    },
  );

  it("redirects the bare relay path to its base", async () => {
    const { handler } = fixture();
    const response = await handler(new Request(`https://t3.test/linked/${PEER}`));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/linked/${PEER}/`);
  });

  it("keeps a peer's own redirect under the relay", async () => {
    const { handler } = fixture({
      upstream: () => new Response(null, { status: 302, headers: { location: "/api/x" } }),
    });
    const response = await handler(relayed("/api/y"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/linked/${PEER}/api/x`);
  });

  it.each([
    ["disabled", 403],
    ["expired", 410],
    ["unreachable", 502],
    ["incompatible", 409],
  ] as const)("answers a %s link with %i", async (reason, status) => {
    const { handler, forwarded } = fixture({
      linkError: new PeerLinkError({ reason, message: reason }),
    });
    expect((await handler(relayed("/api/auth/session"))).status).toBe(status);
    expect(forwarded).toHaveLength(0);
  });

  it("answers an environment that is not linked with 404", async () => {
    const { handler } = fixture();
    const response = await handler(
      new Request("https://t3.test/linked/someone-else/api/auth/session"),
    );
    expect(response.status).toBe(404);
  });
});

describe("parseRelayPath", () => {
  it("splits the environment from the peer path", () => {
    expect(LinkedEnvironmentRelay.parseRelayPath("/linked/a%20b/api/x")).toEqual({
      environmentId: "a b",
      peerPath: "/api/x",
    });
    expect(LinkedEnvironmentRelay.parseRelayPath("/linked/a")).toEqual({
      environmentId: "a",
      peerPath: "",
    });
    expect(LinkedEnvironmentRelay.parseRelayPath("/linked/%E0/api")).toBeNull();
    expect(LinkedEnvironmentRelay.parseRelayPath("/other/a")).toBeNull();
  });
});
