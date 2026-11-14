import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * A project folder as one stream: per entry, a 4-byte big-endian header length,
 * a JSON header, and for a file its bytes. Both ends are this code, so the
 * format needs no archive library and streams any size.
 */
const MAX_HEADER_BYTES = 64 * 1024;

type FrameHeader =
  | { readonly t: "d"; readonly p: string }
  | { readonly t: "f"; readonly p: string; readonly s: number; readonly m?: number }
  | { readonly t: "e" };

export class ProjectTransferError extends Schema.TaggedError<ProjectTransferError>()(
  "ProjectTransferError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const isProjectTransferError = Schema.is(ProjectTransferError);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (header: FrameHeader): Uint8Array => {
  const json = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  return out;
};

const fail = (message: string, cause?: unknown) =>
  Effect.fail(new ProjectTransferError({ message, ...(cause === undefined ? {} : { cause }) }));

interface Entry {
  readonly kind: "d" | "f";
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mode: number;
}

export interface ProjectExport {
  readonly stream: Stream.Stream<Uint8Array, ProjectTransferError>;
  readonly files: number;
  readonly bytes: number;
  /** Symbolic links and other special entries, which are not sent. */
  readonly skipped: ReadonlyArray<string>;
}

/** Lists `root` and streams it. A file that changes size while it is sent fails the stream. */
export const exportProject = Effect.fn("ProjectTransfer.exportProject")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootInfo = yield* fs
    .stat(root)
    .pipe(
      Effect.mapError(
        (cause) => new ProjectTransferError({ message: `${root} cannot be read.`, cause }),
      ),
    );
  if (rootInfo.type !== "Directory") return yield* fail(`${root} is not a folder.`);

  const entries: Array<Entry> = [];
  const skipped: Array<string> = [];
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const absoluteDir = relativeDir === "" ? root : path.join(root, ...relativeDir.split("/"));
    const names = yield* fs
      .readDirectory(absoluteDir)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectTransferError({ message: `${absoluteDir} cannot be listed.`, cause }),
        ),
      );
    for (const name of names.toSorted()) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const absolutePath = path.join(absoluteDir, name);
      // lstat, so a link to a folder cannot loop the walk or reach outside the project.
      const info = yield* fs
        .lstat(absolutePath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectTransferError({ message: `${absolutePath} cannot be read.`, cause }),
          ),
        );
      if (info.type === "Directory") {
        entries.push({ kind: "d", relativePath, absolutePath, size: 0, mode: 0 });
        pending.push(relativePath);
      } else if (info.type === "File") {
        entries.push({
          kind: "f",
          relativePath,
          absolutePath,
          size: Number(info.size),
          mode: info.mode,
        });
      } else {
        skipped.push(relativePath);
      }
    }
  }

  const fileStream = (entry: Entry): Stream.Stream<Uint8Array, ProjectTransferError> => {
    let sent = 0;
    return Stream.concat(
      Stream.succeed(frame({ t: "f", p: entry.relativePath, s: entry.size, m: entry.mode })),
      Stream.concat(
        fs.stream(entry.absolutePath).pipe(
          Stream.mapError(
            (cause) =>
              new ProjectTransferError({ message: `${entry.absolutePath} cannot be read.`, cause }),
          ),
          Stream.map((chunk) => {
            const room = entry.size - sent;
            const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
            sent += part.length;
            return part;
          }),
          Stream.filter((chunk) => chunk.length > 0),
        ),
        Stream.suspend(() =>
          sent === entry.size
            ? Stream.empty
            : Stream.fail(
                new ProjectTransferError({
                  message: `${entry.relativePath} changed while it was being copied. Try again.`,
                }),
              ),
        ),
      ),
    );
  };

  const stream = Stream.fromIterable(entries).pipe(
    Stream.flatMap((entry) =>
      entry.kind === "d"
        ? Stream.succeed(frame({ t: "d", p: entry.relativePath }))
        : fileStream(entry),
    ),
    Stream.concat(Stream.succeed(frame({ t: "e" }))),
  );
  const files = entries.filter((entry) => entry.kind === "f");
  return {
    stream,
    files: files.length,
    bytes: files.reduce((total, entry) => total + entry.size, 0),
    skipped,
  } satisfies ProjectExport;
});

const WINDOWS_RESERVED = /[<>:"|?*]/;

/** A sent relative path as segments, or null when it could leave the target folder. */
export const safeSegments = (
  relativePath: string,
  windows: boolean,
): ReadonlyArray<string> | null => {
  if (relativePath.length === 0 || relativePath.length > 4096) return null;
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.includes("\\") || segment.includes("\u0000")) return null;
    if (windows && WINDOWS_RESERVED.test(segment)) return null;
  }
  return segments;
};

const parseHeader = (bytes: Uint8Array): FrameHeader | null => {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (typeof value !== "object" || value === null) return null;
    const header = value as Record<string, unknown>;
    if (header.t === "e") return { t: "e" };
    if (header.t === "d" && typeof header.p === "string") return { t: "d", p: header.p };
    if (
      header.t === "f" &&
      typeof header.p === "string" &&
      typeof header.s === "number" &&
      Number.isSafeInteger(header.s) &&
      header.s >= 0
    ) {
      return typeof header.m === "number"
        ? { t: "f", p: header.p, s: header.s, m: header.m }
        : { t: "f", p: header.p, s: header.s };
    }
    return null;
  } catch {
    return null;
  }
};

export interface ProjectImport {
  readonly targetPath: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Writes a project stream into `targetPath`, which must not exist yet or be an
 * empty folder. On any failure the folder is removed again, so a retry starts clean.
 */
export const importProject = Effect.fn("ProjectTransfer.importProject")(function* <E>(
  targetPath: string,
  input: Stream.Stream<Uint8Array, E>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = path.sep === "\\";
  if (!path.isAbsolute(targetPath)) return yield* fail(`${targetPath} is not an absolute path.`);
  const existed = yield* fs.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
  if (existed) {
    const info = yield* fs.stat(targetPath).pipe(Effect.option);
    const empty =
      info._tag === "Some" &&
      info.value.type === "Directory" &&
      (yield* fs.readDirectory(targetPath).pipe(Effect.orElseSucceed(() => ["?"]))).length === 0;
    if (!empty) return yield* fail(`${targetPath} already exists. Choose another folder.`);
  }

  let pending = new Uint8Array(0);
  let current: {
    file: FileSystem.File;
    scope: Scope.Closeable;
    remaining: number;
    mode?: number;
    target: string;
  } | null = null;
  let ended = false;
  let files = 0;
  let bytes = 0;

  const finishFile = Effect.gen(function* () {
    if (current === null) return;
    const done = current;
    current = null;
    yield* Scope.close(done.scope, Exit.void);
    if (!windows && done.mode !== undefined) {
      yield* fs.chmod(done.target, done.mode & 0o777).pipe(Effect.ignore);
    }
  });

  const startEntry = Effect.fn("ProjectTransfer.startEntry")(function* (header: FrameHeader) {
    if (header.t === "e") {
      ended = true;
      return;
    }
    const segments = safeSegments(header.p, windows);
    if (segments === null)
      return yield* fail(`The copy holds a path this machine refuses: ${header.p}`);
    const target = path.join(targetPath, ...segments);
    if (header.t === "d") {
      yield* fs
        .makeDirectory(target, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectTransferError({ message: `${target} cannot be created.`, cause }),
          ),
        );
      return;
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.ignore);
    const scope = yield* Scope.make();
    const file = yield* fs.open(target, { flag: "wx" }).pipe(
      Scope.provide(scope),
      Effect.mapError(
        (cause) => new ProjectTransferError({ message: `${target} cannot be written.`, cause }),
      ),
    );
    files += 1;
    current = {
      file,
      scope,
      remaining: header.s,
      target,
      ...(header.m === undefined ? {} : { mode: header.m }),
    };
    if (header.s === 0) yield* finishFile;
  });

  const consume = Effect.fn("ProjectTransfer.consume")(function* (chunk: Uint8Array) {
    let buffer = chunk;
    if (pending.length > 0) {
      buffer = new Uint8Array(pending.length + chunk.length);
      buffer.set(pending);
      buffer.set(chunk, pending.length);
      pending = new Uint8Array(0);
    }
    let offset = 0;
    while (offset < buffer.length) {
      if (current !== null) {
        const length = Math.min(current.remaining, buffer.length - offset);
        yield* current.file.writeAll(buffer.subarray(offset, offset + length)).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectTransferError({
                message: `${current?.target} cannot be written.`,
                cause,
              }),
          ),
        );
        current.remaining -= length;
        bytes += length;
        offset += length;
        if (current.remaining === 0) yield* finishFile;
        continue;
      }
      if (ended) return yield* fail("The copy sent data after its end.");
      if (buffer.length - offset < 4) break;
      const headerLength = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0);
      if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
        return yield* fail("The copy is not in a format this machine reads.");
      }
      if (buffer.length - offset - 4 < headerLength) break;
      const header = parseHeader(buffer.subarray(offset + 4, offset + 4 + headerLength));
      if (header === null) return yield* fail("The copy is not in a format this machine reads.");
      offset += 4 + headerLength;
      yield* startEntry(header);
    }
    if (offset < buffer.length) pending = buffer.slice(offset);
  });

  const written = yield* Effect.gen(function* () {
    yield* fs
      .makeDirectory(targetPath, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectTransferError({ message: `${targetPath} cannot be created.`, cause }),
        ),
      );
    yield* Stream.runForEach(
      input.pipe(
        Stream.mapError((cause) =>
          isProjectTransferError(cause)
            ? cause
            : new ProjectTransferError({ message: "The copy was interrupted.", cause }),
        ),
      ),
      consume,
    );
    if (!ended || current !== null || pending.length > 0) {
      return yield* fail("The copy ended before all of the project arrived.");
    }
    return { targetPath, files, bytes } satisfies ProjectImport;
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        if (current !== null) yield* Scope.close(current.scope, Exit.void);
        current = null;
        yield* (
          existed
            ? fs.readDirectory(targetPath).pipe(
                Effect.flatMap((names) =>
                  Effect.forEach(
                    names,
                    (name) => fs.remove(path.join(targetPath, name), { recursive: true }),
                    {
                      discard: true,
                    },
                  ),
                ),
              )
            : fs.remove(targetPath, { recursive: true })
        ).pipe(Effect.ignore);
      }),
    ),
  );
  return written;
});
