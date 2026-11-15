import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as PhoneHubDeviceHost from "./PhoneHubDeviceHost.ts";

const HUB = "http://127.0.0.1:18091";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The hub's controller API, recording what was asked of it. */
const fakeHub = (online = true) => {
  const requests: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.headers.authorization !== "Bearer hub-token")
        return HttpClientResponse.fromWeb(request, new Response("no", { status: 401 }));
      if (url.pathname === "/api/devices")
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            devices: [
              { id: "lukas-oppo", online, companionVersion: "0.3.0" },
              { id: "../etc", online: true },
            ],
          }),
        );
      if (url.pathname === "/api/devices/lukas-oppo/live.png")
        return HttpClientResponse.fromWeb(
          request,
          new Response(PNG, { headers: { "content-type": "image/png" } }),
        );
      return HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }));
    }),
  );
  return { http, requests };
};

const withHost = <A, E>(
  online: boolean,
  use: (
    host: Effect.Success<ReturnType<typeof PhoneHubDeviceHost.make>>,
    hub: ReturnType<typeof fakeHub>,
    tokenFile: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const tokenFile = path.join(dir, "controller.token");
    yield* fs.writeFileString(tokenFile, "hub-token\n");
    const hub = fakeHub(online);
    const host = yield* PhoneHubDeviceHost.make({ hubUrl: HUB, tokenFile }).pipe(
      Effect.provideService(HttpClient.HttpClient, hub.http),
    );
    return yield* use(host, hub, tokenFile);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("PhoneHubDeviceHost", () => {
  it("is off without a token file and refuses odd hub URLs", () => {
    expect(PhoneHubDeviceHost.configFromEnvironment({})).toBeNull();
    expect(PhoneHubDeviceHost.configFromEnvironment({ T3CODE_PHONE_HUB_TOKEN_FILE: "/t" })).toEqual(
      { hubUrl: "http://127.0.0.1:8091", tokenFile: "/t" },
    );
    expect(
      PhoneHubDeviceHost.configFromEnvironment({
        T3CODE_PHONE_HUB_TOKEN_FILE: "/t",
        T3CODE_PHONE_HUB_URL: "file:///etc/passwd",
      }),
    ).toBeNull();
  });

  it("maps only the serve-sim stream and input paths, for well-formed ids", () => {
    const none = new URLSearchParams();
    expect(
      PhoneHubDeviceHost.hubRoute("/vendor/serve-sim/helper/lukas-oppo/stream.avcc", none),
    ).toEqual({ deviceId: "lukas-oppo", kind: "stream" });
    expect(
      PhoneHubDeviceHost.hubRoute(
        "/vendor/serve-sim/helper/ws",
        new URLSearchParams({ device: "lukas-oppo" }),
      ),
    ).toEqual({ deviceId: "lukas-oppo", kind: "input" });
    expect(
      PhoneHubDeviceHost.hubRoute("/vendor/serve-sim/helper/..%2Fapi/stream.avcc", none),
    ).toBeNull();
    expect(PhoneHubDeviceHost.hubRoute("/vendor/serve-sim/api/screenshot", none)).toBeNull();
    expect(PhoneHubDeviceHost.hubRoute("/vendor/serve-emu/ws", none)).toBeNull();
  });

  it.effect("reports a view-only Simlock-shaped host and lists the phone as physical", () =>
    withHost(true, (host) =>
      Effect.gen(function* () {
        const summary = yield* host.summary;
        expect(summary).toMatchObject({ kind: "simlock", viewOnly: true, id: "phone-control" });
        const ready = yield* host.ensureReady(() => Effect.void);
        const listed = yield* ready.devices.list;
        expect(listed.devices).toEqual([
          {
            id: "lukas-oppo",
            platform: "android",
            name: "lukas-oppo",
            version: "phone-control 0.3.0",
            booted: true,
            physical: true,
          },
        ]);
      }),
    ),
  );

  it.effect("routes the stream and input socket with the hub token, isolated from the client", () =>
    withHost(true, (host) =>
      Effect.gen(function* () {
        const ready = yield* host.ensureReady(() => Effect.void);
        yield* ready.devices.list;
        const stream = yield* ready.upstream!(
          "/vendor/serve-sim/helper/lukas-oppo/stream.avcc",
          new URLSearchParams(),
        );
        expect(stream).toEqual({
          url: `${HUB}/api/devices/lukas-oppo/serve-sim/stream.avcc`,
          headers: { authorization: "Bearer hub-token" },
          protocols: [],
          isolated: true,
        });
        const input = yield* ready.upstream!(
          "/vendor/serve-sim/helper/ws",
          new URLSearchParams({ device: "lukas-oppo" }),
        );
        expect(input?.url).toBe(`${HUB}/api/devices/lukas-oppo/serve-sim/ws`);
        expect(input?.isolated).toBe(true);
        // A phone the hub never listed is never routed.
        expect(
          yield* ready.upstream!(
            "/vendor/serve-sim/helper/other-phone/stream.avcc",
            new URLSearchParams(),
          ),
        ).toBeNull();
      }),
    ),
  );

  it.effect("takes screenshots as the hub's PNG", () =>
    withHost(true, (host, hub) =>
      Effect.gen(function* () {
        const ready = yield* host.ensureReady(() => Effect.void);
        const [phone] = (yield* ready.devices.list).devices;
        expect(yield* ready.devices.screenshot(phone!)).toEqual(PNG);
        expect(hub.requests).toContain("GET /api/devices/lukas-oppo/live.png");
      }),
    ),
  );

  it.effect("never starts agent tools, runs nothing and cannot boot an offline phone", () =>
    withHost(false, (host) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(host.ensureAgentReady(() => Effect.void)))).toBe(
          true,
        );
        const ready = yield* host.ensureReady(() => Effect.void);
        expect((yield* ready.run("adb", ["shell", "input", "tap", "1", "1"])).code).toBe(127);
        const [phone] = (yield* ready.devices.list).devices;
        expect(phone?.booted).toBe(false);
        const boot = yield* Effect.exit(ready.devices.boot(phone!));
        expect(Exit.isFailure(boot)).toBe(true);
      }),
    ),
  );

  it.effect("reads a rotated token on the next request", () =>
    withHost(true, (host, hub, tokenFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const ready = yield* host.ensureReady(() => Effect.void);
        yield* ready.devices.list;
        yield* fs.writeFileString(tokenFile, "rotated");
        expect(Exit.isFailure(yield* Effect.exit(ready.devices.list))).toBe(true);
        expect(hub.requests.filter((request) => request === "GET /api/devices")).toHaveLength(2);
      }),
    ),
  );
});
