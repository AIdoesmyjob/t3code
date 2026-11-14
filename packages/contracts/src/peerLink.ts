import * as Schema from "effect/Schema";

import { AuthEnvironmentScope, AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * A link from this environment to another one (the peer). This environment
 * signed in to the peer's `/mcp` as an outside agent, with a pairing code from
 * the peer, so its agents can work there. The peer enforces the access chosen
 * at linking, and revokes the link from its own Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/** Whether a link can be used now, as worked out when it is listed. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
  /**
   * A browser signed in here can open the peer through this environment's
   * `/linked/<environmentId>/` relay: the link has full access and the peer
   * issues browser sign-ins to it. Absent from older servers.
   */
  browserRelay: Schema.optionalKey(Schema.Boolean),
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

/**
 * A link's name only, for a client that may read threads here but not manage access: enough to
 * name and open a linked environment's threads, without its addresses, access or health.
 */
export const PeerLinkName = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type PeerLinkName = typeof PeerLinkName.Type;

/** The path, on this environment's origin, that relays a browser to a linked peer. */
export const linkedEnvironmentRelayPath = (environmentId: EnvironmentId) =>
  `/linked/${encodeURIComponent(environmentId)}/`;

export const PeerLinkBrowserPairingInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** How the peer lists the browser among its clients, e.g. "Chrome on Android". */
  clientLabel: Schema.optionalKey(Schema.String),
});
export type PeerLinkBrowserPairingInput = typeof PeerLinkBrowserPairingInput.Type;

/**
 * A one-time pairing code from the peer for this browser, redeemed through the
 * relay at `relayPath`. It signs the browser in to the peer itself; this
 * environment only passes it on.
 */
export const PeerLinkBrowserPairingResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.DateTimeUtc,
  relayPath: Schema.String,
});
export type PeerLinkBrowserPairingResult = typeof PeerLinkBrowserPairingResult.Type;

/** What a peer answers on `POST /api/peer/browser-pairing`. */
export const PeerBrowserPairingResponse = Schema.Struct({
  credential: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type PeerBrowserPairingResponse = typeof PeerBrowserPairingResponse.Type;

export const PEER_BROWSER_PAIRING_PATH = "/api/peer/browser-pairing";

/** A full-access link reads a project folder from a peer here, as a framed file stream. */
export const PEER_PROJECT_EXPORT_PATH = "/api/peer/project-export";
/** A full-access link writes a framed file stream into a new folder on a peer here. */
export const PEER_PROJECT_IMPORT_PATH = "/api/peer/project-import";

/**
 * Copies a project folder that has no git remote from one machine to another,
 * each either this environment or one linked here with full access. The target
 * folder must not exist yet, or be empty; `~` means the target's home folder.
 */
export const PeerLinkCopyProjectInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourcePath: Schema.String,
  targetEnvironmentId: EnvironmentId,
  targetPath: Schema.String,
});
export type PeerLinkCopyProjectInput = typeof PeerLinkCopyProjectInput.Type;

export const PeerLinkCopyProjectResult = Schema.Struct({
  /** The absolute folder the project landed in on the target. */
  targetPath: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
  /** Entries left out, such as symbolic links, as relative paths. */
  skipped: Schema.Array(Schema.String),
});
export type PeerLinkCopyProjectResult = typeof PeerLinkCopyProjectResult.Type;

/** What a peer answers on `PUT /api/peer/project-import`. */
export const PeerProjectImportResponse = Schema.Struct({
  targetPath: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});
export type PeerProjectImportResponse = typeof PeerProjectImportResponse.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`t3 pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  /**
   * The environment the user means. Addresses that answer as another one are
   * skipped, and only those that answer as this one are kept.
   */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** What the user calls that environment, to name it when it cannot be reached. */
  expectedLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  // Whether the peer ended the link's session. Older servers never ask it to.
  endedThere: Schema.optionalKey(Schema.Boolean),
});
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
    "disabled",
    "copy_failed",
  ]),
  message: Schema.String,
  /** The environment that answered at the addresses of the one the user picked, when one did. */
  answeredAs: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** What went wrong with one link, as a batch reports it per machine. */
export type PeerLinkFailureKind = "unreachable" | "code_refused" | "wrong_environment" | "other";

export const peerLinkFailureKind = (
  error: Pick<PeerLinkError, "reason" | "answeredAs">,
): PeerLinkFailureKind =>
  error.answeredAs !== undefined
    ? "wrong_environment"
    : error.reason === "unreachable" || error.reason === "not_a_t3_environment"
      ? "unreachable"
      : error.reason === "pairing_rejected"
        ? "code_refused"
        : "other";

/**
 * Where an environment serves one of its threads to an environment linked to it, signed in with
 * the link's own session as on `/mcp`. The stream carries the same items the owner's thread
 * subscription does; history pages and item detail are the owner's too.
 */
const PEER_LINK_THREAD_ROUTE_PREFIX = "/api/links/thread";
export const PEER_LINK_THREAD_STREAM_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/stream`;
export const PEER_LINK_THREAD_HISTORY_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/history`;
export const PEER_LINK_THREAD_ITEM_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/item`;

/** A thread on a linked environment, as a client of this environment names it. */
export const PeerLinkThreadInput = Schema.Struct({
  /** The linked environment the thread lives in. */
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type PeerLinkThreadInput = typeof PeerLinkThreadInput.Type;

export const PeerLinkThreadHistoryInput = Schema.Struct({
  ...PeerLinkThreadInput.fields,
  /** The `historyCursor` of the snapshot or of the page before. */
  cursor: TrimmedNonEmptyString,
});
export type PeerLinkThreadHistoryInput = typeof PeerLinkThreadHistoryInput.Type;

export const PeerLinkThreadItemInput = Schema.Struct({
  ...PeerLinkThreadInput.fields,
  itemId: TurnItemId,
  /** Unused by the server; a client keys its cache on it, as for its own threads' items. */
  revision: Schema.optional(Schema.String),
});
export type PeerLinkThreadItemInput = typeof PeerLinkThreadItemInput.Type;

/** Why a linked environment's thread could not be read, with the reason in words. */
export class PeerLinkThreadReadError extends Schema.TaggedError<PeerLinkThreadReadError>()(
  "PeerLinkThreadReadError",
  {
    reason: Schema.Literals([
      /** Linked environments is off here. */
      "disabled",
      "unknown_link",
      "expired",
      /** The linked environment no longer accepts the link, or refuses the read. */
      "rejected",
      "unreachable",
      "thread_not_found",
      /** The linked environment runs a version that does not serve its threads to a link. */
      "incompatible",
    ]),
    /** What this environment calls the linked one, when it still has the link. */
    label: Schema.NullOr(Schema.String),
    message: Schema.String,
    /** The failure underneath, when the read got as far as the link or the linked environment. */
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A client of this environment asks to pair with one it links to, without typing a code. */
export const PeerLinkClientPairingInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkClientPairingInput = typeof PeerLinkClientPairingInput.Type;

/**
 * A client of this environment asks it for a pairing code from one it links to, to link another
 * environment there with: the linked one mints it, so the user fetches none.
 */
export const PeerLinkLinkPairingInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** The access the new link will have. */
  access: AuthMcpClientAccess,
});
export type PeerLinkLinkPairingInput = typeof PeerLinkLinkPairingInput.Type;

const peerLinkClientPairingTarget = {
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The addresses this environment reaches the linked one at; the client tries them itself. */
  urls: Schema.Array(TrimmedNonEmptyString),
};

/**
 * A one-time pairing credential from the linked environment, or why this link cannot get one, in
 * which case the user pairs there with a code of their own.
 */
export const PeerLinkClientPairingResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("credential"),
    ...peerLinkClientPairingTarget,
    credential: TrimmedNonEmptyString,
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    ...peerLinkClientPairingTarget,
    reason: Schema.Literals([
      /** The link is below full access, so it may not hand out a client's access. */
      "link_access",
      /** The linked environment runs a version from before this. */
      "version",
      /** The linked environment refused: the beta is off there, or its policy forbids pairing. */
      "refused",
      /** This environment could not reach the linked one; the client still might. */
      "unreachable",
    ]),
  }),
]);
export type PeerLinkClientPairingResult = typeof PeerLinkClientPairingResult.Type;

/** What a linking environment asks of the linked one, over the link, for one of its clients. */
export const PeerLinkClientPairingRequest = Schema.Struct({
  /** The client's scopes on the linking environment. The credential never carries more. */
  scopes: Schema.Array(AuthEnvironmentScope),
  /** The client's name there, shown in Connections here. */
  clientLabel: TrimmedNonEmptyString,
  /**
   * Set when the pairing is for a link from another environment, not for the client itself: the
   * credential is then a link pairing code at this access, and `scopes` is not used.
   */
  link: Schema.optionalKey(Schema.Struct({ access: AuthMcpClientAccess })),
});
export type PeerLinkClientPairingRequest = typeof PeerLinkClientPairingRequest.Type;

export const PeerLinkClientPairingCredential = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type PeerLinkClientPairingCredential = typeof PeerLinkClientPairingCredential.Type;

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome and the access the user chose.
 */
export const PeerLinkRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("link"),
      /** The machine the user picked, when they picked one rather than typing an address. */
      environmentId: Schema.optionalKey(EnvironmentId),
      /** What the client calls that machine. */
      label: Schema.optionalKey(TrimmedNonEmptyString),
      /** The addresses the client knows for that machine, most preferred first. */
      urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
      access: AuthMcpClientAccess,
      pairingCode: TrimmedNonEmptyString,
    }),
    /** Answers with a machine this environment is already linked to, as it is. */
    Schema.Struct({ type: Schema.Literal("use-existing"), environmentId: EnvironmentId }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type PeerLinkRequestAnswerInput = typeof PeerLinkRequestAnswerInput.Type;

const PEER_LINK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
} as const;

export const PeerLinkRequestFailureReason = Schema.Literals(
  Object.keys(PEER_LINK_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof PEER_LINK_REQUEST_FAILURE_MESSAGES
  >,
);
export type PeerLinkRequestFailureReason = typeof PeerLinkRequestFailureReason.Type;

/**
 * Answering a link request failed before anything was linked. A link the
 * other environment refused is not this error: the card records it as failed.
 */
export class PeerLinkRequestError extends Schema.TaggedError<PeerLinkRequestError>()(
  "PeerLinkRequestError",
  {
    reason: PeerLinkRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return PEER_LINK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
