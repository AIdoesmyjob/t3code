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
 * own API, as the desktop app does over SSH. The peer still checks the browser's
 * own sign-in there (`Authorization` or `wsTicket`); cookies never cross.
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

const proxyHttp = Effect.fn("LinkedEnvironmentRelay.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
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
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(headers),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient
    .execute(upstreamRequest)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
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
  const contentType = responseHeaders["content-type"];
  if (
    responseHeaders["content-length"] === undefined ||
    contentType?.startsWith("text/event-stream") === true ||
    contentType?.startsWith("multipart/") === true
  ) {
    const cacheControl = responseHeaders["cache-control"];
    responseHeaders["cache-control"] =
      cacheControl === undefined ? "no-store, no-transform" : `${cacheControl}, no-transform`;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    ...(contentType ? { contentType } : {}),
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
) {
  const userAgent = request.headers["user-agent"];
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(userAgent ? { headers: { "user-agent": userAgent } } : {}),
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

  // This server's own browser session, from its cookie: the Authorization
  // header, if any, is the browser's sign-in at the peer.
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

  const origin = yield* links.relayOrigin(environmentId).pipe(Effect.result);
  if (origin._tag === "Failure") {
    return jsonError(
      linkErrorStatus(origin.failure),
      origin.failure.reason,
      origin.failure.message,
    );
  }
  const upstreamUrl = `${origin.success}${parsed.peerPath}${url.value.search}`;

  if (isWebSocketUpgrade(request)) {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws")).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Linked environment relay could not open the peer's socket", cause).pipe(
          Effect.as(jsonError(502, "unreachable", "The linked environment did not answer.")),
        ),
      ),
    );
  }
  return yield* proxyHttp(request, upstreamUrl, relayBase).pipe(
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
