import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  type ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { browserPairingLabel, LINKED_BROWSER_SCOPES } from "./PeerBrowserPairingRoute.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const NoopToolkit = Toolkit.make(
  Tool.make("noop", {
    description: "Does nothing.",
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);
const noopHandlers = McpToolAccess.toLayer(NoopToolkit, {
  noop: McpToolAccess.reads(() => Effect.succeed("ok")),
});

const serveBox = (descriptor: ExecutionEnvironmentDescriptor) =>
  servePeer(descriptor, McpHttpServer.toolkitRegistration(NoopToolkit, noopHandlers));

const makeLaptop = layerLinkingEnvironment(descriptorOf("environment-laptop", "Laptop")).pipe(
  Layer.build,
  Effect.map((context) => Context.get(context, PeerLinks.PeerLinks)),
);

const relayingBox = descriptorOf("environment-box", "Box", { linkedBrowserRelay: true });

it.effect("a full-access link brings a browser sign-in the peer redeems with narrowed scopes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = yield* serveBox(relayingBox);
      const links = yield* makeLaptop;
      yield* linkTo(links, box, "full-access");

      const listed = yield* links.list;
      expect(listed.map((link) => [link.status, link.browserRelay])).toEqual([["reachable", true]]);
      expect(yield* links.relayOrigin(relayingBox.environmentId)).toBe(box.url);

      const issued = yield* links.browserPairing({
        environmentId: relayingBox.environmentId,
        clientLabel: "Chrome\u0000 on Android",
      });
      expect(issued.relayPath).toBe("/linked/environment-box/");
      expect(issued.label).toBe("Box");

      const access = yield* box.auth.exchangeBootstrapCredentialForAccessToken(
        issued.credential,
        undefined,
        { deviceType: "desktop", label: "Chrome" },
      );
      const scopes = access.scope.split(" ");
      expect(scopes).toContain(AuthOrchestrationOperateScope);
      expect(scopes).toContain(AuthTerminalOperateScope);
      expect(scopes).not.toContain(AuthAccessWriteScope);
      expect(scopes).not.toContain(AuthRelayWriteScope);
      expect([...scopes].toSorted()).toEqual([...LINKED_BROWSER_SCOPES].toSorted());

      // The code is one-time.
      const reused = yield* box.auth
        .exchangeBootstrapCredentialForAccessToken(issued.credential, undefined, {
          deviceType: "desktop",
        })
        .pipe(Effect.flip);
      expect(reused._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link without full access gets no browser sign-in and no relay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = yield* serveBox(relayingBox);
      const links = yield* makeLaptop;
      yield* linkTo(links, box, "auto");

      expect((yield* links.list).map((link) => link.browserRelay)).toEqual([false]);
      const refused = yield* links
        .browserPairing({ environmentId: relayingBox.environmentId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      const relay = yield* links.relayOrigin(relayingBox.environmentId).pipe(Effect.flip);
      expect(relay.reason).toBe("pairing_rejected");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a peer that does not offer browser sign-ins is refused before it is asked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = yield* serveBox(descriptorOf("environment-box", "Box"));
      const links = yield* makeLaptop;
      yield* linkTo(links, box, "full-access");

      expect((yield* links.list).map((link) => link.browserRelay)).toEqual([false]);
      const refused = yield* links
        .browserPairing({ environmentId: relayingBox.environmentId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("incompatible");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the peer refuses browser sign-ins while its Linked environments beta is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = yield* serveBox(relayingBox);
      const links = yield* makeLaptop;
      yield* linkTo(links, box, "full-access");
      yield* box.settings.updateSettings({ linkedEnvironmentsEnabled: false });

      const refused = yield* links
        .browserPairing({ environmentId: relayingBox.environmentId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      expect(refused.message).toContain("Linked environments is off");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it("labels a browser sign-in after the client and the link, without control characters", () => {
  expect(browserPairingLabel("T3 Code · Laptop", "Chrome\u0000 on\nAndroid")).toBe(
    "Chrome on Android via T3 Code · Laptop",
  );
  expect(browserPairingLabel("T3 Code · Laptop", undefined)).toBe("Browser via T3 Code · Laptop");
  expect(browserPairingLabel("L", "x".repeat(200))).toHaveLength(80);
});
