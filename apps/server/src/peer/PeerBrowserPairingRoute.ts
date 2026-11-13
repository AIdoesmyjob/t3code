import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  PEER_BROWSER_PAIRING_PATH,
  PeerBrowserPairingResponse,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Only a full-access peer link may ask: it already runs agents here with every
 * permission, so a browser sign-in for its relay grants nothing new. The browser
 * gets the standard scopes minus access and relay management.
 */
export const LINKED_BROWSER_SCOPES = AuthStandardClientScopes.filter(
  (scope) =>
    scope !== AuthAccessWriteScope && scope !== AuthRelayReadScope && scope !== AuthRelayWriteScope,
);

const MAX_BODY_BYTES = 4 * 1024;
const MAX_LABEL_CHARS = 80;

const PairingRequestBody = Schema.Struct({
  clientLabel: Schema.optionalKey(Schema.String),
});
const decodeBody = Schema.decodeUnknownEffect(PairingRequestBody);
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(PeerBrowserPairingResponse));

const NO_STORE = { "cache-control": "no-store" } as const;

const refuse = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status, headers: NO_STORE });

/** A label the peer can show among its clients, without control characters. */
export const browserPairingLabel = (linkLabel: string, clientLabel: string | undefined) => {
  const client = (clientLabel ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = client.length > 0 ? `${client} via ${linkLabel}` : `Browser via ${linkLabel}`;
  return label.slice(0, MAX_LABEL_CHARS);
};

const handle = Effect.fn("PeerBrowserPairingRoute.handle")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;

  const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
  if (client._tag === "None" || !client.value.peerLink) {
    return refuse(401, "unauthorized", "Only a linked environment can ask for a browser sign-in.");
  }
  const linksOn = yield* settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  if (!linksOn) {
    return refuse(
      403,
      "linked_environments_off",
      "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
    );
  }
  if (client.value.access !== "full-access") {
    return refuse(
      403,
      "insufficient_access",
      "Opening this machine in a browser needs a link with full access. Link it again with full access.",
    );
  }

  if (Number(request.headers["content-length"] ?? "0") > MAX_BODY_BYTES) {
    return refuse(413, "too_large", "The request is too large.");
  }
  const body = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.flatMap(decodeBody),
    Effect.option,
  );
  if (body._tag === "None") return refuse(400, "bad_request", "The request body is not valid.");

  const issued = yield* auth
    .issuePairingCredential({
      scopes: LINKED_BROWSER_SCOPES,
      label: browserPairingLabel(client.value.label, body.value.clientLabel),
    })
    .pipe(Effect.result);
  if (issued._tag === "Failure") {
    const error = issued.failure;
    if (error._tag === "ManagedPolicyRefusedError") {
      return refuse(403, "managed_policy", error.message);
    }
    yield* Effect.logWarning("Could not issue a browser sign-in for a linked environment", error);
    return refuse(500, "internal_error", "This machine could not issue a browser sign-in.");
  }
  yield* Effect.logInfo("Issued a browser sign-in for a linked environment", {
    link: client.value.label,
  });
  const encoded = yield* encodeResponse({
    credential: issued.success.credential,
    expiresAt: issued.success.expiresAt,
  });
  return HttpServerResponse.text(encoded, {
    status: 200,
    contentType: "application/json",
    headers: NO_STORE,
  });
});

// Route handlers get request-time services only, so these are taken when the layer is built.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const settings = yield* ServerSettings.ServerSettingsService;
    return HttpRouter.add("POST", PEER_BROWSER_PAIRING_PATH, handle(auth, settings));
  }),
);
