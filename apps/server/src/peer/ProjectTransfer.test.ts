import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ProjectTransfer from "./ProjectTransfer.ts";

const binary = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 7) % 256);

/** A project with nested folders, an empty file, a binary file and a link. */
const makeProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-src-" });
  yield* fs.makeDirectory(path.join(root, "src", "deep"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "empty-dir"));
  yield* fs.writeFileString(path.join(root, "README.md"), "# hello\n");
  yield* fs.writeFileString(path.join(root, "src", "deep", "notes.txt"), "a\nb\nc\n");
  yield* fs.writeFile(path.join(root, "src", "data.bin"), binary);
  yield* fs.writeFile(path.join(root, "empty.txt"), new Uint8Array(0));
  yield* fs.writeFileString(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  yield* fs.chmod(path.join(root, "run.sh"), 0o755);
  yield* fs.symlink(path.join(root, "README.md"), path.join(root, "link-to-readme"));
  return root;
});

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const all = [...chunks];
      const out = new Uint8Array(all.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of all) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }),
  );

/** The same bytes, re-cut into pieces of `size`, as a network would deliver them. */
const rechunk = (bytes: Uint8Array, size: number) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) =>
      bytes.subarray(index * size, (index + 1) * size),
    ),
  );

describe("ProjectTransfer", () => {
  it.effect("copies a folder byte for byte, in any chunking, and leaves links out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeProject;
        const exported = yield* ProjectTransfer.exportProject(root);
        expect(exported.files).toBe(5);
        expect(exported.skipped).toEqual(["link-to-readme"]);
        const bytes = yield* collect(exported.stream);

        for (const size of [3, 4099, 65_536]) {
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-dst-" });
          const target = path.join(parent, "copy");
          const imported = yield* ProjectTransfer.importProject(target, rechunk(bytes, size));
          expect(imported).toEqual({ targetPath: target, files: 5, bytes: exported.bytes });
          expect(yield* fs.readFileString(path.join(target, "README.md"))).toBe("# hello\n");
          expect(yield* fs.readFileString(path.join(target, "src", "deep", "notes.txt"))).toBe(
            "a\nb\nc\n",
          );
          expect(new Uint8Array(yield* fs.readFile(path.join(target, "src", "data.bin")))).toEqual(
            binary,
          );
          expect((yield* fs.readFile(path.join(target, "empty.txt"))).length).toBe(0);
          expect((yield* fs.stat(path.join(target, "empty-dir"))).type).toBe("Directory");
          expect((yield* fs.stat(path.join(target, "run.sh"))).mode & 0o111).not.toBe(0);
          expect(yield* fs.exists(path.join(target, "link-to-readme"))).toBe(false);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a folder that already holds files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeProject;
        const exported = yield* ProjectTransfer.exportProject(root);
        const error = yield* ProjectTransfer.importProject(root, exported.stream).pipe(Effect.flip);
        expect(error.message).toContain("already exists");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a half-written copy when the stream breaks off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeProject;
        const bytes = yield* collect((yield* ProjectTransfer.exportProject(root)).stream);
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-dst-" });
        const target = path.join(parent, "copy");
        const error = yield* ProjectTransfer.importProject(
          target,
          rechunk(bytes.subarray(0, Math.floor(bytes.length / 2)), 4096),
        ).pipe(Effect.flip);
        expect(error.message).toContain("ended before");
        expect(yield* fs.exists(target)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("refuses paths that could leave the target folder", () => {
    expect(ProjectTransfer.safeSegments("src/a.ts", false)).toEqual(["src", "a.ts"]);
    for (const bad of [
      "",
      "../x",
      "a/../../x",
      "/etc/passwd",
      "a//b",
      "a/./b",
      "a\\b",
      "a\u0000",
    ]) {
      expect(ProjectTransfer.safeSegments(bad, false)).toBeNull();
    }
    expect(ProjectTransfer.safeSegments("TODO: later.md", false)).toEqual(["TODO: later.md"]);
    expect(ProjectTransfer.safeSegments("TODO: later.md", true)).toBeNull();
  });
});
