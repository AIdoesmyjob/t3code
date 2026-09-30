import {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FastCheck from "effect/testing/FastCheck";

import { encodeShellSnapshotForCache } from "./persistence.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped.
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = FastCheck.sample(Schema.toArbitrary(schema), { numRuns: 1000 });
    const decoded = yield* Effect.forEach(generated, (value) =>
      encode(value).pipe(Effect.flatMap(decode), Effect.option),
    );
    return Arr.getSomes(decoded);
  });
const encodeSnapshot = Schema.encodeEffect(OrchestrationShellSnapshot);

describe("encodeShellSnapshotForCache", () => {
  it.effect("matches the Schema encoding of a generated snapshot", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationThreadShell);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const snapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        projects,
        threads,
        updatedAt: "2026-09-25T00:00:00.000Z",
      };

      expect(threads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      expect(yield* encodeShellSnapshotForCache(snapshot)).toEqual(yield* encodeSnapshot(snapshot));
    }),
  );
});
