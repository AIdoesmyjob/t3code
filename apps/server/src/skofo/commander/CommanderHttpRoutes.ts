import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as CommanderService from "./CommanderService.ts";

const authenticate = Effect.fnUntraced(function* (
  serverAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

// Route handlers get request-time services only, so these are taken when the layer is built.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const commander = yield* CommanderService.CommanderService;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/skofo/commander",
        Effect.gen(function* () {
          yield* authenticate(serverAuth, AuthOrchestrationReadScope);
          const summary = yield* commander.getSummary;
          return HttpServerResponse.jsonUnsafe(summary);
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/api/skofo/commander/ensure",
        Effect.gen(function* () {
          yield* authenticate(serverAuth, AuthOrchestrationOperateScope);
          yield* commander.ensureProvisioned;
          const summary = yield* commander.getSummary;
          return HttpServerResponse.jsonUnsafe(summary);
        }).pipe(
          Effect.catchTags({
            EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
            EnvironmentInternalError: HttpServerRespondable.toResponse,
            EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
          }),
        ),
      ),
    );
  }),
);
