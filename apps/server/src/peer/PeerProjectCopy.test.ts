import { NodeHttpServer } from "@effect/platform-node";
import { type ExecutionEnvironmentDescriptor, OrchestratorMcpFailure } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
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

const LAPTOP = descriptorOf("environment-laptop", "Laptop");
const makeLaptop = layerLinkingEnvironment(LAPTOP).pipe(
  Layer.build,
  Effect.map((context) => Context.get(context, PeerLinks.PeerLinks)),
);
const copyingBox = descriptorOf("environment-box", "Box", {
  linkedBrowserRelay: true,
  linkedProjectCopy: true,
});

const makeFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copy-src-" });
  yield* fs.makeDirectory(path.join(root, "notes"));
  yield* fs.writeFileString(path.join(root, "notes", "week1.md"), "atoms\n");
  yield* fs.writeFile(path.join(root, "photo.bin"), Uint8Array.from([0, 255, 1, 254]));
  return root;
});

it.effect("copies a project folder to a linked machine and back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const box = yield* serveBox(copyingBox);
      const links = yield* makeLaptop;
      yield* linkTo(links, box, "full-access");
      const source = yield* makeFolder;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copy-dst-" });

      const there = path.join(parent, "on-box");
      const sent = yield* links.copyProject({
        sourceEnvironmentId: LAPTOP.environmentId,
        sourcePath: source,
        targetEnvironmentId: copyingBox.environmentId,
        targetPath: there,
      });
      expect(sent).toEqual({ targetPath: there, files: 2, bytes: 10, skipped: [] });
      expect(yield* fs.readFileString(path.join(there, "notes", "week1.md"))).toBe("atoms\n");

      const back = path.join(parent, "back-home");
      const received = yield* links.copyProject({
        sourceEnvironmentId: copyingBox.environmentId,
        sourcePath: there,
        targetEnvironmentId: LAPTOP.environmentId,
        targetPath: back,
      });
      expect(received.files).toBe(2);
      expect([...new Uint8Array(yield* fs.readFile(path.join(back, "photo.bin")))]).toEqual([
        0, 255, 1, 254,
      ]);

      // A second copy into the same folder is refused, and the first stays intact.
      const again = yield* links
        .copyProject({
          sourceEnvironmentId: LAPTOP.environmentId,
          sourcePath: source,
          targetEnvironmentId: copyingBox.environmentId,
          targetPath: there,
        })
        .pipe(Effect.flip);
      expect(again.reason).toBe("copy_failed");
      expect(again.message).toContain("already exists");
      expect(yield* fs.readFileString(path.join(there, "notes", "week1.md"))).toBe("atoms\n");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const refusal = (
  descriptor: ExecutionEnvironmentDescriptor,
  access: "auto" | "full-access",
  reason: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* makeFolder;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copy-dst-" });
      const box = yield* serveBox(descriptor);
      const links = yield* makeLaptop;
      yield* linkTo(links, box, access);
      const error = yield* links
        .copyProject({
          sourceEnvironmentId: LAPTOP.environmentId,
          sourcePath: source,
          targetEnvironmentId: descriptor.environmentId,
          targetPath: path.join(parent, "x"),
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe(reason);
      expect(yield* fs.exists(path.join(parent, "x"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

it.effect("refuses to copy over a link without full access", () =>
  refusal(copyingBox, "auto", "pairing_rejected"),
);

it.effect("refuses to copy to a machine whose version cannot take a copy", () =>
  refusal(
    descriptorOf("environment-box", "Box", { linkedBrowserRelay: true }),
    "full-access",
    "incompatible",
  ),
);
