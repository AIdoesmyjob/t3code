import { AuthAccessWriteScope, EnvironmentId, type PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as PeerLinks from "./PeerLinks.ts";

/**
 * `/linked/<id>/…` relays this server's signed-in browser to a full-access peer's
 * own API with the one session this environment holds there, so every browser
 * sees the same machines. A browser's own sign-in is dropped; cookies never cross.
 */
const LINKED_RELAY_PREFIX = "/linked";

/** The peer paths a client uses. Everything else, such as `/mcp` or the web app, stays closed. */
const isRelayedPath = (path: string) =>
  path === "/ws" ||
  path.startsWith("/ws/") ||
  path === "/oauth/token" ||
  path.startsWith("/.well-known/t3/") ||
  (path.startsWith("/api/") && !path.startsWith("/api/peer/"));

/** Headers that describe this hop, carry this server's sign-in, or would let the peer misread the caller. */
const isDroppedRequestHeader = (name: string) =>
  name === "authorization" ||
  name === "host" ||
  name === "connection" ||
  name === "keep-alive" ||
  name === "upgrade" ||
  name === "te" ||
  name === "trailer" ||
  name === "transfer-encoding" ||
  name === "content-length" ||
  name === "accept-encoding" ||
  name === "cookie" ||
  name === "origin" ||
  name === "referer" ||
  name === "forwarded" ||
  name === "x-real-ip" ||
  name.startsWith("proxy-") ||
  name.startsWith("sec-websocket-") ||
  name.startsWith("x-forwarded-") ||
  // An auth proxy in front of this server names its user this way; the peer must not trust it.
  name.startsWith("remote-") ||
  name.startsWith("cf-");

const isDroppedResponseHeader = (name: string) =>
  name === "set-cookie" ||
  name === "connection" ||
  name === "keep-alive" ||
  name === "transfer-encoding" ||
  name === "content-encoding" ||
  name === "strict-transport-security" ||
  name === "alt-svc";

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const jsonError = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error, message },
    { status, headers: { "cache-control": "no-store" } },
  );

const linkErrorStatus = (error: PeerLinkError) => {
  switch (error.reason) {
    case "disabled":
    case "pairing_rejected":
      return 403;
    case "unknown_link":
      return 404;
    case "expired":
      return 410;
    case "incompatible":
      return 409;
    case "unreachable":
    case "not_a_t3_environment":
      return 502;
    default:
      return 500;
  }
};

/** `/linked/<id>/<rest>` split into the environment and the peer path, both still URL-encoded. */
export const parseRelayPath = (pathname: string) => {
  const match = /^\/linked\/([^/]+)(\/.*)?$/.exec(pathname);
  if (match === null) return null;
  let environmentId: string;
  try {
    environmentId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (environmentId.length === 0 || environmentId.length > 128) return null;
  return { environmentId, peerPath: match[2] ?? "" };
};

/** A peer's redirect within itself stays under the relay. */
const relayLocation = (location: string, relayBase: string) =>
  location.startsWith("/") && !location.startsWith("//")
    ? `${relayBase}${location.slice(1)}`
    : location;

/** Bodies up to this size are held so a request can be sent again with a new session. */
const MAX_RETRYABLE_BODY_BYTES = 1024 * 1024;

type RelaySession = { readonly origin: string; readonly token: string };

const proxyHttp = Effect.fn("LinkedEnvironmentRelay.proxyHttp")(function* (
  links: PeerLinks.PeerLinks["Service"],
  environmentId: EnvironmentId,
  session: RelaySession,
  request: HttpServerRequest.HttpServerRequest,
  peerPathAndQuery: string,
  relayBase: string,
) {
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !isDroppedRequestHeader(name)) headers[name] = value;
  }
  // Fetch would decompress a compressed answer and leave its length wrong; this
  // server compresses what it sends on where that helps.
  headers["accept-encoding"] = "identity";
  const contentType = request.headers["content-type"];
  const declaredLength = Number(request.headers["content-length"] ?? Number.NaN);
  const hasBody = method !== "GET" && method !== "HEAD";
  // A small body is read once so the request can be repeated with a new session.
  const heldBody =
    hasBody && Number.isFinite(declaredLength) && declaredLength <= MAX_RETRYABLE_BODY_BYTES
      ? Option.some(new Uint8Array(yield* request.arrayBuffer))
      : Option.none<Uint8Array>();
  const send = (target: RelaySession) =>
    httpClient
      .execute(
        HttpClientRequest.make(method)(`${target.origin}${peerPathAndQuery}`).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bearerToken(target.token),
          !hasBody
            ? (self) => self
            : Option.isSome(heldBody)
              ? HttpClientRequest.bodyUint8Array(heldBody.value, contentType)
              : HttpClientRequest.bodyStream(request.stream, { contentType }),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  let response = yield* send(session);
  if (response.status === 401 && (!hasBody || Option.isSome(heldBody))) {
    // The peer dropped the relay's session (revoked or expired): sign in again once.
    yield* links.invalidateRelaySession(environmentId, session.token);
    response = yield* send(yield* links.relaySession(environmentId));
  }
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || isDroppedResponseHeader(name)) continue;
    responseHeaders[name] = name === "location" ? relayLocation(value, relayBase) : value;
  }
  if (response.headers["content-encoding"] !== undefined) {
    delete responseHeaders["content-length"];
  }
  // A stream of unknown length (events, media) must reach the browser as it
  // comes; compression here would hold it back.
  const responseType = responseHeaders["content-type"];
  if (
    responseHeaders["content-length"] === undefined ||
    responseType?.startsWith("text/event-stream") === true ||
    responseType?.startsWith("multipart/") === true
  ) {
    const cacheControl = responseHeaders["cache-control"];
    responseHeaders["cache-control"] =
      cacheControl === undefined ? "no-store, no-transform" : `${cacheControl}, no-transform`;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    ...(responseType ? { contentType: responseType } : {}),
  });
});

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyWebSocket = Effect.fn("LinkedEnvironmentRelay.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
) {
  const userAgent = request.headers["user-agent"];
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    headers: {
      authorization: `Bearer ${token}`,
      ...(userAgent ? { "user-agent": userAgent } : {}),
    },
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const handle = Effect.fn("LinkedEnvironmentRelay.handle")(function* (
  links: PeerLinks.PeerLinks["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const parsed = parseRelayPath(url.value.pathname);
  if (parsed === null) return jsonError(404, "not_found", "No such linked environment path.");
  const environmentId = EnvironmentId.make(parsed.environmentId);
  const relayBase = `${LINKED_RELAY_PREFIX}/${encodeURIComponent(environmentId)}/`;
  if (parsed.peerPath === "") {
    return HttpServerResponse.redirect(relayBase, { status: 308 });
  }
  if (!isRelayedPath(parsed.peerPath)) {
    return jsonError(404, "not_found", "This path is not available through a linked environment.");
  }

  // This server's own browser session, from its cookie. An Authorization header
  // is not this server's and is dropped before the request goes on.
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session) || session.value.method !== "browser-session-cookie") {
    return jsonError(401, "unauthorized", "Sign in to this T3 Code first.");
  }
  if (!session.value.scopes.includes(AuthAccessWriteScope)) {
    return jsonError(
      403,
      "insufficient_scope",
      "Opening a linked environment needs permission to manage access here.",
    );
  }

  const relay = yield* links.relaySession(environmentId).pipe(Effect.result);
  if (relay._tag === "Failure") {
    return jsonError(linkErrorStatus(relay.failure), relay.failure.reason, relay.failure.message);
  }
  const peerPathAndQuery = `${parsed.peerPath}${url.value.search}`;

  if (isWebSocketUpgrade(request)) {
    const upstreamUrl = `${relay.success.origin}${peerPathAndQuery}`.replace(/^http/, "ws");
    return yield* proxyWebSocket(request, upstreamUrl, relay.success.token).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Linked environment relay could not open the peer's socket", cause).pipe(
          Effect.as(jsonError(502, "unreachable", "The linked environment did not answer.")),
        ),
      ),
    );
  }
  return yield* proxyHttp(
    links,
    environmentId,
    relay.success,
    request,
    peerPathAndQuery,
    relayBase,
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Linked environment relay request failed", cause).pipe(
        Effect.as(jsonError(502, "unreachable", "The linked environment did not answer.")),
      ),
    ),
  );
});

// Route handlers get request-time services only, so the link service is taken when the layer is built.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const links = yield* PeerLinks.PeerLinks;
    return HttpRouter.add("*", `${LINKED_RELAY_PREFIX}/*`, handle(links));
  }),
);
