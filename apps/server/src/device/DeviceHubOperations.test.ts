import { describe, expect, it } from "@effect/vitest";
import { DeviceOperationError, LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { HostDevice } from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const device: HostDevice = {
  id: "emulator-5554",
  name: "Pixel_API_35",
  version: "Android 15",
  platform: "android",
  booted: true,
  physical: false,
};
const png = new Uint8Array([137, 80, 78, 71]);

const operations = (respond: (attempt: number) => Effect.Effect<Response>) => {
  let attempts = 0;
  const http = HttpClient.make((request) =>
    respond(++attempts).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  );
  return {
    attempts: () => attempts,
    ops: makeDeviceHubOperations({
      hostId: LOCAL_DEVICE_HOST_ID,
      origin: "http://hub.test",
      http,
      run: () => Effect.die("not used"),
      androidAvailable: Effect.succeed(true),
    }),
  };
};

describe("hub screenshots", () => {
  it.effect("carries the hub's explanation and retries a 5xx once", () =>
    Effect.gen(function* () {
      const { ops, attempts } = operations(() =>
        Effect.succeed(
          new Response(`scrcpy exited with code 134\n${"x".repeat(1000)}`, { status: 500 }),
        ),
      );
      const error = yield* ops.screenshot(device).pipe(Effect.flip);
      expect(attempts()).toBe(2);
      expect(error).toBeInstanceOf(DeviceOperationError);
      expect(error.reason).toBe("hub_rejected");
      expect(error.detail).toMatch(/^Hub responded 500: scrcpy exited with code 134 x+…$/);
      expect(error.detail!.length).toBeLessThanOrEqual(300);
      expect(error.message).toContain("scrcpy exited with code 134");
    }),
  );

  it.effect("does not retry a 4xx", () =>
    Effect.gen(function* () {
      const { ops, attempts } = operations(() =>
        Effect.succeed(new Response("unknown device", { status: 404 })),
      );
      const error = yield* ops.screenshot(device).pipe(Effect.flip);
      expect(attempts()).toBe(1);
      expect(error.detail).toBe("Hub responded 404: unknown device");
    }),
  );

  it.effect("retries once when the first capture times out", () =>
    Effect.gen(function* () {
      const { ops, attempts } = operations((attempt) =>
        attempt === 1 ? Effect.never : Effect.succeed(new Response(png)),
      );
      const fiber = yield* ops.screenshot(device).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      expect(Array.from(yield* Fiber.join(fiber))).toEqual(Array.from(png));
      expect(attempts()).toBe(2);
    }),
  );

  it.effect("reports a timeout after the retry also times out", () =>
    Effect.gen(function* () {
      const { ops, attempts } = operations(() => Effect.never);
      const fiber = yield* ops.screenshot(device).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(fiber);
      expect(attempts()).toBe(2);
      expect(error.reason).toBe("request_failed");
      expect(error.detail).toBe("The hub did not answer within 20s.");
    }),
  );
});
