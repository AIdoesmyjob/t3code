import {
  PEER_PROJECT_EXPORT_PATH,
  PEER_PROJECT_IMPORT_PATH,
  PeerProjectImportResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { expandHomePath } from "../os-jank.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectTransfer from "./ProjectTransfer.ts";

const NO_STORE = { "cache-control": "no-store" } as const;
const encodeImportResponse = Schema.encodeEffect(Schema.fromJsonString(PeerProjectImportResponse));
const encodeSkipped = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const refuse = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status, headers: NO_STORE });

/**
 * Only a full-access link may move project folders here: it can already run
 * agents with every permission on this machine, so this grants nothing new.
 */
const authorizeLink = Effect.fn("PeerProjectTransferRoute.authorizeLink")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
  request: HttpServerRequest.HttpServerRequest,
) {
  const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
  if (client._tag === "None" || !client.value.peerLink) {
    return Option.some(refuse(401, "unauthorized", "Only a linked environment can copy projects."));
  }
  const linksOn = yield* settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  if (!linksOn) {
    return Option.some(
      refuse(
        403,
        "linked_environments_off",
        "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
      ),
    );
  }
  if (client.value.access !== "full-access") {
    return Option.some(
      refuse(403, "insufficient_access", "Copying projects needs a link with full access."),
    );
  }
  return Option.none();
});

const requestedPath = Effect.fn("PeerProjectTransferRoute.requestedPath")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const url = requestUrl(request);
  const raw = Option.isSome(url) ? url.value.searchParams.get("path") : null;
  if (raw === null || raw.trim().length === 0) return Option.none<string>();
  const path = yield* Path.Path;
  const expanded = yield* expandHomePath(raw.trim());
  return path.isAbsolute(expanded) ? Option.some(path.resolve(expanded)) : Option.none<string>();
});

const handleExport = Effect.fn("PeerProjectTransferRoute.export")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const refused = yield* authorizeLink(auth, settings, request);
  if (Option.isSome(refused)) return refused.value;
  const root = yield* requestedPath(request);
  if (Option.isNone(root)) return refuse(400, "bad_request", "Name the project folder to copy.");
  const exported = yield* ProjectTransfer.exportProject(root.value).pipe(Effect.result);
  if (exported._tag === "Failure") return refuse(404, "not_found", exported.failure.message);
  const skipped = yield* encodeSkipped(exported.success.skipped.slice(0, 50)).pipe(
    Effect.orElseSucceed(() => "[]"),
  );
  return HttpServerResponse.stream(exported.success.stream, {
    status: 200,
    contentType: "application/octet-stream",
    headers: {
      ...NO_STORE,
      "x-t3-project-files": String(exported.success.files),
      "x-t3-project-bytes": String(exported.success.bytes),
      "x-t3-project-skipped": encodeURIComponent(skipped),
    },
  });
});

const handleImport = Effect.fn("PeerProjectTransferRoute.import")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const refused = yield* authorizeLink(auth, settings, request);
  if (Option.isSome(refused)) return refused.value;
  const target = yield* requestedPath(request);
  if (Option.isNone(target)) return refuse(400, "bad_request", "Name the folder to copy into.");
  const imported = yield* ProjectTransfer.importProject(target.value, request.stream).pipe(
    Effect.result,
  );
  if (imported._tag === "Failure") {
    yield* Effect.logWarning("A project copy from a linked environment failed", {
      target: target.value,
      error: imported.failure.message,
    });
    return refuse(409, "copy_failed", imported.failure.message);
  }
  yield* Effect.logInfo("Received a project copy from a linked environment", {
    target: imported.success.targetPath,
    files: imported.success.files,
  });
  return HttpServerResponse.text(yield* encodeImportResponse(imported.success), {
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
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const withFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    return Layer.mergeAll(
      HttpRouter.add("GET", PEER_PROJECT_EXPORT_PATH, withFiles(handleExport(auth, settings))),
      HttpRouter.add("PUT", PEER_PROJECT_IMPORT_PATH, withFiles(handleImport(auth, settings))),
    );
  }),
);
