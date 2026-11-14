import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ExecutionEnvironmentDescriptor,
  linkedEnvironmentRelayPath,
  MCP_PEER_LINK_SOFTWARE_ID,
  PEER_BROWSER_PAIRING_PATH,
  PEER_PROJECT_EXPORT_PATH,
  PEER_PROJECT_IMPORT_PATH,
  PeerBrowserPairingResponse,
  type PeerLink,
  type PeerLinkBrowserPairingInput,
  type PeerLinkBrowserPairingResult,
  type PeerLinkCopyProjectInput,
  type PeerLinkCopyProjectResult,
  type PeerLinkCreateInput,
  PeerLinkError,
  PeerProjectImportResponse,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectTransfer from "./ProjectTransfer.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long a peer's descriptor may take before a route counts as unreachable.
 * A tailnet or relayed route to a machine that is waking up takes longer.
 */
const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);
/** How long a listing waits on a link's addresses; a real call still gives a waking peer `probeTimeout`. */
const LIST_PROBE_TIMEOUT = Duration.seconds(3);
/**
 * How long the browser relay reuses an address it found answering as a peer.
 * Every relayed request asks, and a probe per request would double each one.
 */
const RELAY_ORIGIN_TTL_MS = 30_000;
const BROWSER_PAIRING_TIMEOUT = Duration.seconds(15);
/** How the peer lists the session the browser relay uses there. */
const RELAY_SESSION_CLIENT_LABEL = "Browser relay";

/** Node's TLS verification code in a failed request's cause chain, if any. */
export const certificateErrorCode = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (
      Predicate.hasProperty(current, "code") &&
      typeof current.code === "string" &&
      /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|INVALID_(CA|PURPOSE)|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH/.test(
        current.code,
      )
    )
      return current.code;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return undefined;
};

/** A usable link: where to reach the peer and the token to send there. */
export interface ResolvedPeerLink {
  readonly link: PeerLink;
  /** The first address that answered as this peer. */
  readonly url: string;
  readonly token: string;
}

export const LINKED_ENVIRONMENTS_OFF =
  "Linked environments is off on this machine. Turn it on in Settings → Labs.";

/**
 * Links from this environment to others. Linking signs this environment in to
 * the peer's `/mcp` as an outside agent with a pairing code from the peer, the
 * same MCP OAuth flow an outside agent uses, without a browser. The peer's
 * session token is kept in the server secret store; the table keeps the rest.
 */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly link: (input: PeerLinkCreateInput) => Effect.Effect<PeerLink, PeerLinkError>;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /** Forgets the link here. The peer still lists the session until it is revoked there. */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    /** An address that answers as the linked peer, with its token, ready to call. */
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    /**
     * A one-time sign-in from the peer for a browser signed in here, to open
     * the peer through this environment's `/linked/<id>/` relay. Needs a
     * full-access link to a peer that offers it (`linkedBrowserRelay`).
     */
    readonly browserPairing: (
      input: PeerLinkBrowserPairingInput,
    ) => Effect.Effect<PeerLinkBrowserPairingResult, PeerLinkError>;
    /**
     * The address the browser relay forwards to for `environmentId`, under the
     * same conditions as `browserPairing`. Briefly cached.
     */
    readonly relayOrigin: (environmentId: EnvironmentId) => Effect.Effect<string, PeerLinkError>;
    /**
     * Where the browser relay forwards to for `environmentId`, and the one session
     * it uses there for every browser signed in here. Made from a one-time browser
     * sign-in from the peer; kept in the secret store until the peer rejects it.
     */
    readonly relaySession: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<{ readonly origin: string; readonly token: string }, PeerLinkError>;
    /**
     * Copies a project folder between this environment and machines linked here
     * with full access, for a project without a git remote. Streams the folder.
     */
    readonly copyProject: (
      input: PeerLinkCopyProjectInput,
    ) => Effect.Effect<PeerLinkCopyProjectResult, PeerLinkError>;
    /** Drops `token` after the peer rejected it, so the next call makes a new session. */
    readonly invalidateRelaySession: (
      environmentId: EnvironmentId,
      token: string,
    ) => Effect.Effect<void>;
    /** Records the outcome of a call, so listing shows whether the peer answered last time. */
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
  }
>()("t3/peer/PeerLinks") {}

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
  readonly fenced: number;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * The base URL a peer is reached at, normalised to its origin. The pairing
 * code and then the link's token travel to it, so plain http is accepted only
 * where the network already encrypts: this machine, or a Tailscale address.
 */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is not an http or https address.`,
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale address.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

/** Whether a host is this machine's own loopback. Tests serve their peers there, so they narrow it. */
export const LoopbackHost = Context.Reference<(host: string) => boolean>(
  "t3/peer/PeerLinks/LoopbackHost",
  { defaultValue: () => isLocalLoopbackHost },
);

/** Whether a peer holds a linked agent to its limits and keeps its work within its link. */
const linkLimitsHold = (peer: { readonly capabilities: ExecutionEnvironmentCapabilities }) =>
  peer.capabilities.mcpModeLimitHeader === true && peer.capabilities.linkFence === true;

/** Whether a browser signed in here may open the peer through this environment's relay. */
const offersBrowserRelay = (
  link: Pick<PeerLink, "access">,
  peer: { readonly capabilities: ExecutionEnvironmentCapabilities },
) => link.access === "full-access" && peer.capabilities.linkedBrowserRelay === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const isOwnLoopback = yield* LoopbackHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh name for one link's token; the row records it. */
  const newSecretName = random.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a pairing code or token:
  // a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  /**
   * The environment answering at `origin`, or nothing when it does not answer
   * as T3 Code. A certificate this machine rejects fails instead, since
   * the peer may well be there.
   */
  const describe = (origin: string) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      // A brief network drop must not list a live peer as down; the timeout still bounds both tries.
      Effect.retry({
        times: 1,
        schedule: Schedule.spaced("1 second"),
        while: (error) => certificateErrorCode(error) === undefined,
      }),
      Effect.timeout(probeTimeout(origin)),
      Effect.asSome,
      Effect.catch((error) => {
        const code = certificateErrorCode(error);
        return code === undefined
          ? Effect.succeed(Option.none<ExecutionEnvironmentDescriptor>())
          : Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} presented a certificate this machine rejected (${code}).`,
              }),
            );
      }),
    );

  /** Whether `url` answers as `environmentId`, counting an untrusted certificate as no. */
  const answersAs = Effect.fn("PeerLinks.answersAs")(function* (
    url: string,
    environmentId: EnvironmentId,
  ) {
    const found = yield* describe(url).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.filter(found, (peer) => peer.environmentId === environmentId);
  });

  const toLink = Effect.fn("PeerLinks.toLink")(function* (row: PeerLinkRow) {
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      urls: yield* decodeUrls(row.urls_json),
      access: yield* decodeAccess(row.access),
      linkedAt: DateTime.makeUnsafe(row.linked_at),
      // Its token predates link fencing, so the peer would not fence its work:
      // like an expired link, only a new pairing code brings it back.
      expiresAt: DateTime.makeUnsafe(row.fenced === 1 ? row.expires_at : row.linked_at),
      lastReachedAt: row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
      lastError: row.last_error,
    } satisfies PeerLink;
  }, Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  /** Signs in to the peer's `/mcp` with a pairing code: register, decide, exchange. */
  const signIn = Effect.fn("PeerLinks.signIn")(
    function* (origin: string, input: PeerLinkCreateInput, clientName: string) {
      const client = yield* clientFor(origin);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({
          payload: {
            client_name: clientName,
            redirect_uris: [LINK_REDIRECT_URI],
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
          },
        })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* random.randomBytes(32));
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* random.randomBytes(16));
      const resource = `${origin}/mcp`;
      const decided = yield* client.mcpOAuth
        .decision({
          headers: {},
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: Redacted.make(state),
              resource,
            },
            decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      return yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code: Redacted.make(code),
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: Redacted.make(verifier),
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
    },
    (effect, origin) =>
      effect.pipe(
        // Endpoint errors are mapped above; what is left is the transport or an
        // answer this version cannot decode.
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "incompatible",
                message: `${origin} answered in a shape this version does not understand. Update both environments.`,
                cause,
              }),
            ),
          HttpClientError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} stopped answering while linking.`,
                cause,
              }),
            ),
        }),
      ),
  );

  /**
   * The addresses that answer as `environmentId`, in the order given, with
   * what the first one answered. Addresses this environment would not send
   * credentials to are skipped; when every one is, the failure says why.
   */
  const answeringAs = Effect.fn("PeerLinks.answeringAs")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    name: string,
  ) {
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* peerOrigin(url);
          // Loopback is this machine, where anything may answer as the one picked.
          if (isOwnLoopback(new URL(origin).hostname)) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} is this machine, not ${name}.`,
            });
          }
          return { origin, descriptor: yield* describe(origin) };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const matching = checked.flatMap((result) =>
      Result.isSuccess(result) &&
      Option.isSome(result.success.descriptor) &&
      result.success.descriptor.value.environmentId === environmentId
        ? [{ origin: result.success.origin, descriptor: result.success.descriptor.value }]
        : [],
    );
    const first = matching[0];
    if (first === undefined) {
      const refusals = checked.flatMap((result) =>
        Result.isFailure(result) ? [result.failure.message] : [],
      );
      return yield* new PeerLinkError({
        reason: "unreachable",
        message:
          refusals.length === checked.length
            ? `This environment could not reach ${name}: ${refusals.join(" ")}`
            : `This environment could not reach ${name} at ${urls.join(", ")}.`,
      });
    }
    // Each address is kept once, even when two spellings share an origin.
    const origins = [...new Set(matching.map((found) => found.origin))];
    return { primary: first.origin, peer: first.descriptor, origins };
  });

  /** The peer at `url`, with every address checked for credentials first. */
  const answeringAt = Effect.fn("PeerLinks.answeringAt")(function* (urls: ReadonlyArray<string>) {
    const origins = yield* Effect.forEach(urls, peerOrigin);
    const primary = origins[0]!;
    const descriptor = yield* describe(primary);
    if (Option.isNone(descriptor)) {
      return yield* new PeerLinkError({
        reason: "not_a_t3_environment",
        message: `Nothing at ${primary} answered as a T3 Code environment.`,
      });
    }
    return { primary, peer: descriptor.value, origins };
  });

  const link: PeerLinks["Service"]["link"] = Effect.fn("PeerLinks.link")(function* (input) {
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    const urls = [input.url, ...(input.alternateUrls ?? [])];
    // The user picked a machine: link through the addresses that answer as
    // it, so one that now answers as another never receives the pairing code.
    const { primary, peer, origins } =
      input.expectedEnvironmentId === undefined
        ? yield* answeringAt(urls)
        : yield* answeringAs(
            urls,
            input.expectedEnvironmentId,
            input.expectedLabel ?? input.expectedEnvironmentId,
          );
    // Anything can answer as a linked machine, so an address alone renews its
    // link only where the link already reaches it, and never moves it.
    if (input.expectedEnvironmentId === undefined) {
      const row = yield* readRow(peer.environmentId);
      const existing = Option.isSome(row) ? yield* toLink(row.value) : undefined;
      if (
        existing !== undefined &&
        DateTime.isGreaterThan(existing.expiresAt, yield* DateTime.now) &&
        !existing.urls.includes(primary)
      ) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message: `${primary} answers as ${existing.label}, which is already linked at another address. If ${existing.label} moved, forget that link first.`,
        });
      }
    }
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new PeerLinkError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    if (!linkLimitsHold(peer)) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    const issued = yield* signIn(primary, input, `T3 Code · ${self.label}`);
    const now = yield* DateTime.now;
    const linked: PeerLink = {
      environmentId: peer.environmentId,
      label: peer.label,
      urls: origins,
      access: input.access,
      linkedAt: now,
      expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
      lastReachedAt: now,
      lastError: null,
    };
    // The token goes under a name of its own before the row points at it,
    // so the row and its token are replaced together.
    const secretName = yield* newSecretName;
    yield* secrets
      .set(secretName, new TextEncoder().encode(issued.access_token))
      .pipe(Effect.catch(failStorage));
    // A token no row names could never be removed.
    const previous = yield* Effect.gen(function* () {
      const urlsJson = yield* encodeUrls(origins).pipe(Effect.catch(failStorage));
      const previous = yield* readRow(peer.environmentId);
      yield* sql`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced
        ) VALUES (
          ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
          ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
          ${DateTime.formatIso(now)}, NULL, 1
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          secret_name = excluded.secret_name,
          fenced = excluded.fenced,
          label = excluded.label,
          urls_json = excluded.urls_json,
          access = excluded.access,
          linked_at = excluded.linked_at,
          expires_at = excluded.expires_at,
          last_reached_at = excluded.last_reached_at,
          last_error = NULL
      `.pipe(Effect.catch(failStorage));
      return previous;
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    // Linking again replaces the old token. A racing link may leave its own
    // behind; it is unused either way.
    if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
      yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
    }
    return linked;
  });

  /** A peer's label follows its machine name, so the link takes the one its own address answers with. */
  const withLabel = (link: PeerLink, label: string) =>
    label === link.label
      ? Effect.succeed(link)
      : sql`
          UPDATE peer_environment_links SET label = ${label}
          WHERE environment_id = ${link.environmentId}
        `.pipe(Effect.ignoreCause({ log: true }), Effect.as({ ...link, label }));

  const statusOf = Effect.fn("PeerLinks.statusOf")(function* (
    link: PeerLink,
    now: DateTime.Utc,
  ): Effect.fn.Return<PeerLinkSummary> {
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now)) return { ...link, status: "expired" };
    // A race over no addresses never settles.
    if (link.urls.length === 0) return { ...link, status: "unreachable" };
    const answered = yield* Effect.raceAll(
      link.urls.map((url) =>
        answersAs(url, link.environmentId).pipe(Effect.flatMap(Effect.fromOption)),
      ),
    ).pipe(Effect.timeoutOption(LIST_PROBE_TIMEOUT), Effect.orElseSucceed(Option.none));
    if (Option.isNone(answered)) return { ...link, status: "unreachable" };
    return {
      ...(yield* withLabel(link, answered.value.label)),
      status: "reachable",
      browserRelay: offersBrowserRelay(link, answered.value),
    };
  });

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, toLink);
    const now = yield* DateTime.now;
    return yield* Effect.forEach(links, (link) => statusOf(link, now), {
      concurrency: "unbounded",
    });
  });

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toLink(row)),
        }),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = Effect.fn("PeerLinks.unlink")(
    function* (environmentId) {
      const deleted = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      for (const row of deleted) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
      relayTokens.delete(environmentId);
      yield* secrets.remove(yield* relaySecretName(environmentId)).pipe(Effect.catch(failStorage));
      return deleted.length > 0;
    },
  );

  const resolveDetailed = Effect.fn("PeerLinks.resolveDetailed")(function* (
    environmentId: EnvironmentId,
  ) {
    const notLinked = new PeerLinkError({
      reason: "unknown_link",
      message: `This environment is not linked to ${environmentId}. t3_environment_links lists the linked ones.`,
    });
    const row = yield* readRow(environmentId);
    if (Option.isNone(row)) return yield* notLinked;
    const link = yield* toLink(row.value);
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
      return yield* new PeerLinkError({
        reason: "expired",
        message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
      });
    }
    const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
    if (Option.isNone(stored)) {
      // An unlink between the two reads removes the row before its secret.
      if (Option.isNone(yield* readRow(environmentId))) return yield* notLinked;
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: `The link to ${link.label} lost its credential. Link it again.`,
      });
    }
    // The token goes only to an address that still answers as this peer,
    // so one that now answers as another machine never receives it.
    let fenced = true;
    let label = link.label;
    let browserRelay = false;
    let projectCopy = false;
    const url = yield* Effect.findFirst(link.urls, (candidate) =>
      answersAs(candidate, environmentId).pipe(
        Effect.map((found) => {
          if (Option.isNone(found)) return false;
          fenced = linkLimitsHold(found.value);
          label = found.value.label;
          browserRelay = offersBrowserRelay(link, found.value);
          projectCopy =
            link.access === "full-access" && found.value.capabilities.linkedProjectCopy === true;
          return true;
        }),
      ),
    );
    if (Option.isNone(url)) {
      return yield* new PeerLinkError({
        reason: "unreachable",
        message: `${link.label} did not answer at ${link.urls.join(", ")}.`,
      });
    }
    // A link made before the peer had to fence linked work, or a peer moved
    // back to such a version, would carry work past those limits.
    if (!fenced) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${link.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    const resolved: ResolvedPeerLink = {
      link: yield* withLabel(link, label),
      url: url.value,
      token: new TextDecoder().decode(stored.value),
    };
    return { resolved, browserRelay, projectCopy };
  });

  const resolve: PeerLinks["Service"]["resolve"] = (environmentId) =>
    resolveDetailed(environmentId).pipe(Effect.map(({ resolved }) => resolved));

  const requireEnabled = enabled.pipe(
    Effect.flatMap((on) =>
      on
        ? Effect.void
        : Effect.fail(
            new PeerLinkError({
              reason: "disabled",
              message: "Linked environments is off here. Turn it on in Settings → Labs.",
            }),
          ),
    ),
  );

  /** A link the browser relay may use: on here, full access, and a peer that offers it. */
  const resolveForBrowser = Effect.fn("PeerLinks.resolveForBrowser")(function* (
    environmentId: EnvironmentId,
  ) {
    yield* requireEnabled;
    const { resolved, browserRelay } = yield* resolveDetailed(environmentId);
    if (resolved.link.access !== "full-access") {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: `Opening ${resolved.link.label} in a browser needs a link with full access. Link it again with full access.`,
      });
    }
    if (!browserRelay) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${resolved.link.label} runs a T3 Code version that cannot be opened through this one. Update it first.`,
      });
    }
    return resolved;
  });

  const relayOrigins = new Map<
    EnvironmentId,
    { readonly origin: string; readonly until: number }
  >();

  const relayOrigin: PeerLinks["Service"]["relayOrigin"] = Effect.fn("PeerLinks.relayOrigin")(
    function* (environmentId) {
      const now = yield* Clock.currentTimeMillis;
      const cached = relayOrigins.get(environmentId);
      if (cached !== undefined && cached.until > now) {
        // The setting can go off at any time; nothing new may start over a link then.
        yield* requireEnabled;
        return cached.origin;
      }
      relayOrigins.delete(environmentId);
      const resolved = yield* resolveForBrowser(environmentId);
      relayOrigins.set(environmentId, { origin: resolved.url, until: now + RELAY_ORIGIN_TTL_MS });
      return resolved.url;
    },
  );

  /** A one-time browser sign-in from the peer, labelled after `clientLabel`. */
  const requestBrowserCode = Effect.fn("PeerLinks.requestBrowserCode")(function* (
    environmentId: EnvironmentId,
    resolved: ResolvedPeerLink,
    clientLabel: string | undefined,
  ) {
    const label = resolved.link.label;
    const response = yield* peerHttpClient
      .execute(
        HttpClientRequest.post(`${resolved.url}${PEER_BROWSER_PAIRING_PATH}`).pipe(
          HttpClientRequest.bearerToken(resolved.token),
          HttpClientRequest.bodyJsonUnsafe(clientLabel === undefined ? {} : { clientLabel }),
        ),
      )
      .pipe(
        Effect.timeout(BROWSER_PAIRING_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new PeerLinkError({
              reason: "unreachable",
              message: `${label} did not answer the browser sign-in request.`,
              cause,
            }),
        ),
      );
    if (response.status !== 200) {
      const detail = yield* response.json.pipe(
        Effect.map((body) =>
          Predicate.isObject(body) && typeof body.message === "string" ? body.message : null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const message =
        response.status === 401
          ? `${label} no longer accepts this link. Link it again.`
          : response.status === 404
            ? `${label} runs a T3 Code version that cannot be opened through this one. Update it first.`
            : (detail ?? `${label} refused the browser sign-in (HTTP ${response.status}).`);
      yield* recordOutcome(environmentId, { error: message });
      return yield* new PeerLinkError({
        reason: response.status === 404 ? "incompatible" : "pairing_rejected",
        message,
      });
    }
    const body = yield* response.text.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PeerBrowserPairingResponse))),
      Effect.mapError(
        (cause) =>
          new PeerLinkError({
            reason: "not_a_t3_environment",
            message: `${label} answered the browser sign-in request with something unexpected.`,
            cause,
          }),
      ),
    );
    yield* recordOutcome(environmentId, { error: null });
    return body;
  });

  const browserPairing: PeerLinks["Service"]["browserPairing"] = Effect.fn(
    "PeerLinks.browserPairing",
  )(function* (input) {
    const resolved = yield* resolveForBrowser(input.environmentId);
    const body = yield* requestBrowserCode(input.environmentId, resolved, input.clientLabel);
    return {
      environmentId: input.environmentId,
      label: resolved.link.label,
      credential: body.credential,
      expiresAt: body.expiresAt,
      relayPath: linkedEnvironmentRelayPath(input.environmentId),
    };
  });

  /** Where the relay keeps its session at one peer; environment ids are not file names. */
  const relaySecretName = (environmentId: EnvironmentId) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(environmentId)).pipe(
      Effect.map((hash) => `peer-relay-${Hex.encode(hash).slice(0, 32)}`),
      Effect.orDie,
    );

  const relayTokens = new Map<EnvironmentId, string>();
  // One session per peer: concurrent first requests must not each sign in.
  const relayTokenLock = yield* Semaphore.make(1);

  /** Redeems a one-time browser sign-in at the peer, the way a browser would. */
  const redeemRelayCode = Effect.fn("PeerLinks.redeemRelayCode")(function* (
    origin: string,
    label: string,
    credential: string,
  ) {
    const unreachable = (cause: unknown) =>
      new PeerLinkError({
        reason: "unreachable",
        message: `${label} did not answer the relay sign-in.`,
        cause,
      });
    const response = yield* peerHttpClient
      .execute(
        HttpClientRequest.post(`${origin}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }),
        ),
      )
      .pipe(Effect.timeout(BROWSER_PAIRING_TIMEOUT), Effect.mapError(unreachable));
    if (response.status !== 200) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: `${label} refused the relay sign-in (HTTP ${response.status}).`,
      });
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AuthAccessTokenResult)),
      Effect.mapError(
        (cause) =>
          new PeerLinkError({
            reason: "not_a_t3_environment",
            message: `${label} answered the relay sign-in with something unexpected.`,
            cause,
          }),
      ),
    );
    return body.access_token;
  });

  const relaySession: PeerLinks["Service"]["relaySession"] = Effect.fn("PeerLinks.relaySession")(
    function* (environmentId) {
      const origin = yield* relayOrigin(environmentId);
      const cached = relayTokens.get(environmentId);
      if (cached !== undefined) return { origin, token: cached };
      return yield* relayTokenLock.withPermits(1)(
        Effect.gen(function* () {
          const current = relayTokens.get(environmentId);
          if (current !== undefined) return { origin, token: current };
          const secretName = yield* relaySecretName(environmentId);
          const stored = yield* secrets.get(secretName).pipe(Effect.catch(failStorage));
          if (Option.isSome(stored)) {
            const token = new TextDecoder().decode(stored.value);
            relayTokens.set(environmentId, token);
            return { origin, token };
          }
          const resolved = yield* resolveForBrowser(environmentId);
          const code = yield* requestBrowserCode(
            environmentId,
            resolved,
            RELAY_SESSION_CLIENT_LABEL,
          );
          const token = yield* redeemRelayCode(resolved.url, resolved.link.label, code.credential);
          yield* secrets
            .set(secretName, new TextEncoder().encode(token))
            .pipe(Effect.catch(failStorage));
          relayTokens.set(environmentId, token);
          yield* Effect.logInfo("Signed the browser relay in to a linked environment", {
            link: resolved.link.label,
          });
          return { origin: resolved.url, token };
        }),
      );
    },
  );

  const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );

  const copyFailed = (message: string, cause?: unknown) =>
    new PeerLinkError({
      reason: "copy_failed",
      message,
      ...(cause === undefined ? {} : { cause }),
    });

  const resolveForCopy = Effect.fn("PeerLinks.resolveForCopy")(function* (
    environmentId: EnvironmentId,
  ) {
    const { resolved, projectCopy } = yield* resolveDetailed(environmentId);
    if (resolved.link.access !== "full-access") {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: `Copying a project to or from ${resolved.link.label} needs a link with full access.`,
      });
    }
    if (!projectCopy) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${resolved.link.label} runs a T3 Code version that cannot copy projects. Update it first.`,
      });
    }
    return resolved;
  });

  /** A peer's refusal, in its own words when it gave them. */
  const peerRefusal = <E>(
    response: { readonly status: number; readonly json: Effect.Effect<unknown, E> },
    label: string,
  ) =>
    response.json.pipe(
      Effect.map((body) =>
        Predicate.isObject(body) && typeof body.message === "string"
          ? body.message
          : `${label} refused the copy (HTTP ${response.status}).`,
      ),
      Effect.orElseSucceed(() => `${label} refused the copy (HTTP ${response.status}).`),
    );

  const copyProject: PeerLinks["Service"]["copyProject"] = Effect.fn("PeerLinks.copyProject")(
    function* (input) {
      yield* requireEnabled;
      const own = yield* environment.getEnvironmentId;
      if (input.sourceEnvironmentId === input.targetEnvironmentId) {
        return yield* copyFailed("The project is already on that machine.");
      }

      // Where the folder comes from: this machine's disk, or the peer's export.
      let source: { stream: Stream.Stream<Uint8Array, unknown>; skipped: ReadonlyArray<string> };
      if (input.sourceEnvironmentId === own) {
        const exported = yield* withFiles(ProjectTransfer.exportProject(input.sourcePath)).pipe(
          Effect.mapError((error) => copyFailed(error.message, error)),
        );
        source = { stream: exported.stream, skipped: exported.skipped };
      } else {
        const peer = yield* resolveForCopy(input.sourceEnvironmentId);
        const response = yield* peerHttpClient
          .execute(
            HttpClientRequest.get(`${peer.url}${PEER_PROJECT_EXPORT_PATH}`).pipe(
              HttpClientRequest.setUrlParam("path", input.sourcePath),
              HttpClientRequest.bearerToken(peer.token),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new PeerLinkError({
                  reason: "unreachable",
                  message: `${peer.link.label} did not answer the copy request.`,
                  cause,
                }),
            ),
          );
        if (response.status !== 200) {
          return yield* copyFailed(yield* peerRefusal(response, peer.link.label));
        }
        const skippedHeader = response.headers["x-t3-project-skipped"];
        const skipped = yield* Effect.try({
          try: () => decodeURIComponent(skippedHeader ?? "[]"),
          catch: (cause) => copyFailed("The skipped-file list could not be read.", cause),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        source = { stream: response.stream, skipped };
      }

      // Where it goes: this machine's disk, or the peer's import.
      if (input.targetEnvironmentId === own) {
        const targetPath = yield* withFiles(
          expandHomePath(input.targetPath).pipe(
            Effect.map((expanded) => pathService.resolve(expanded)),
          ),
        );
        const imported = yield* withFiles(
          ProjectTransfer.importProject(targetPath, source.stream),
        ).pipe(Effect.mapError((error) => copyFailed(error.message, error)));
        return { ...imported, skipped: source.skipped };
      }
      const target = yield* resolveForCopy(input.targetEnvironmentId);
      const response = yield* peerHttpClient
        .execute(
          HttpClientRequest.put(`${target.url}${PEER_PROJECT_IMPORT_PATH}`).pipe(
            HttpClientRequest.setUrlParam("path", input.targetPath),
            HttpClientRequest.bearerToken(target.token),
            HttpClientRequest.bodyStream(
              source.stream.pipe(
                Stream.mapError((cause) => copyFailed("The project could not be read.", cause)),
              ),
              { contentType: "application/octet-stream" },
            ),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PeerLinkError({
                reason: "unreachable",
                message: `${target.link.label} did not take the copy.`,
                cause,
              }),
          ),
        );
      if (response.status !== 200) {
        return yield* copyFailed(yield* peerRefusal(response, target.link.label));
      }
      const imported = yield* response.text.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(PeerProjectImportResponse)),
        ),
        Effect.mapError((cause) =>
          copyFailed(`${target.link.label} answered the copy with something unexpected.`, cause),
        ),
      );
      return { ...imported, skipped: source.skipped };
    },
  );

  const invalidateRelaySession: PeerLinks["Service"]["invalidateRelaySession"] = (
    environmentId,
    token,
  ) =>
    relayTokenLock.withPermits(1)(
      Effect.gen(function* () {
        if (relayTokens.get(environmentId) !== token) return;
        relayTokens.delete(environmentId);
        yield* secrets.remove(yield* relaySecretName(environmentId));
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  return PeerLinks.of({
    enabled,
    link,
    list,
    get,
    unlink,
    resolve,
    browserPairing,
    relayOrigin,
    relaySession,
    invalidateRelaySession,
    copyProject,
    recordOutcome,
  });
});

export const layer = Layer.effect(PeerLinks, make);
