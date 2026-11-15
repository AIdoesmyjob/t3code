/**
 * skofo: the owner's phone, view only, from the phone-control hub (`T3CODE_PHONE_HUB_TOKEN_FILE`,
 * `T3CODE_PHONE_HUB_URL`). Frames are the companion's redacted screenshots; nothing goes back.
 * Shaped as a Simlock host so clients paint serve-sim seed frames; `viewOnly` marks it.
 */
import {
  DeviceBootError,
  type DeviceHostId,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type DevicePlatformAvailability,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DeviceHost from "./DeviceHost.ts";

export const PHONE_HUB_HOST_ID = "phone-control" as DeviceHostId;
export const PHONE_HUB_LABEL = "My phone (view only)";
const DEFAULT_HUB_URL = "http://127.0.0.1:8091";
const REQUEST_TIMEOUT = Duration.seconds(10);
const STREAM_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/stream\.avcc$/;
const INPUT_PATH = "/vendor/serve-sim/helper/ws";
/** Hub device ids are short slugs (`lukas-oppo`); anything else never reaches a hub URL. */
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const VIEW_ONLY_REASON =
  "This phone is view only in T3. Control it with the phone_command tools, which enforce its blocklist.";

export interface PhoneHubConfig {
  readonly hubUrl: string;
  readonly tokenFile: string;
}

/** Reads the host's settings from the server's environment; null leaves the host off. */
export const configFromEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): PhoneHubConfig | null => {
  const tokenFile = env.T3CODE_PHONE_HUB_TOKEN_FILE?.trim();
  if (!tokenFile) return null;
  const hubUrl = (env.T3CODE_PHONE_HUB_URL?.trim() || DEFAULT_HUB_URL).replace(/\/$/, "");
  try {
    const url = new URL(hubUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { hubUrl, tokenFile };
};

const HubDevices = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      online: Schema.Boolean,
      companionVersion: Schema.optional(Schema.String),
      supportedCommands: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeHubDevices = Schema.decodeUnknownEffect(HubDevices);

/** Maps a client hub path to the hub's own serve-sim route for that phone, or null. */
export const hubRoute = (
  hubPath: string,
  search: URLSearchParams,
): { readonly deviceId: string; readonly kind: "stream" | "input" } | null => {
  const stream = STREAM_PATH.exec(hubPath);
  let deviceId: string | null;
  try {
    deviceId = stream
      ? decodeURIComponent(stream[1]!)
      : hubPath === INPUT_PATH
        ? search.get("device")
        : null;
  } catch {
    return null;
  }
  if (deviceId === null || !DEVICE_ID.test(deviceId)) return null;
  return { deviceId, kind: stream ? "stream" : "input" };
};

export const make = Effect.fn("PhoneHubDeviceHost.make")(function* (config: PhoneHubConfig) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const hostId = PHONE_HUB_HOST_ID;
  const hub = config.hubUrl;
  let ready: DeviceHost.DeviceHostReady | null = null;
  let platforms: ReadonlyArray<DevicePlatformAvailability> = [
    { platform: "android", available: true },
  ];
  // The ids the hub last listed; only those reach hub URLs.
  let known = new Set<string>();

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId,
      hostLabel: PHONE_HUB_LABEL,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });
  const operationError = (operation: string) => (cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });

  // Read on each use, so a rotated controller token applies without a restart.
  const currentToken = fs.readFileString(config.tokenFile).pipe(
    Effect.map((token) => token.trim()),
    Effect.filterOrFail(
      (token) => token.length > 0,
      () => unavailable("The phone-control hub token file is empty."),
    ),
    Effect.mapError((cause) =>
      cause._tag === "DeviceHostUnavailableError"
        ? cause
        : unavailable("Could not read the phone-control hub token.", cause),
    ),
  );

  const get = Effect.fn("PhoneHubDeviceHost.get")(function* (route: string) {
    const token = yield* currentToken;
    return yield* http
      .execute(HttpClientRequest.get(`${hub}${route}`).pipe(HttpClientRequest.bearerToken(token)))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(REQUEST_TIMEOUT));
  });

  const list = Effect.gen(function* () {
    const body = yield* get("/api/devices").pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeHubDevices),
      Effect.scoped,
    );
    const devices = body.devices
      .filter((device) => DEVICE_ID.test(device.id))
      .map((device): DeviceHost.HostDevice => ({
        id: device.id,
        platform: "android",
        name: device.id,
        version: device.companionVersion ? `phone-control ${device.companionVersion}` : "Offline",
        booted: device.online,
        physical: true,
      }));
    known = new Set(devices.map((device) => device.id));
    platforms = [{ platform: "android", available: true }];
    return { devices, detail: undefined };
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        platforms = [
          {
            platform: "android",
            available: false,
            reason: "The phone-control hub is not answering.",
          },
        ];
      }),
    ),
    Effect.mapError(operationError("list")),
  );

  const screenshot = Effect.fn("PhoneHubDeviceHost.screenshot")(
    function* (device: DeviceHost.HostDevice) {
      if (!known.has(device.id)) return yield* unavailable("The hub does not list this phone.");
      const response = yield* get(`/api/devices/${encodeURIComponent(device.id)}/live.png`);
      return new Uint8Array(yield* response.arrayBuffer);
    },
    Effect.scoped,
    Effect.mapError(operationError("screenshot")),
  );

  const devices: DeviceHost.DeviceOperations = {
    list,
    boot: (device) =>
      device.booted
        ? Effect.succeed(device.id)
        : Effect.fail(
            new DeviceBootError({
              hostId,
              deviceId: device.id,
              reason: "launch_failed",
              diagnostics:
                "The phone is offline. It reconnects on its own when it has a network; T3 cannot start it.",
              cause: new Error("phone offline"),
            }),
          ),
    attach: () => Effect.void,
    // The phone is the owner's; closing the panel only ends the view.
    shutdown: () => Effect.void,
    screenshot,
  };

  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = Effect.fn(
    "PhoneHubDeviceHost.upstream",
  )(function* (hubPath: string, search: URLSearchParams) {
    const route = hubRoute(hubPath, search);
    if (!route || !known.has(route.deviceId)) return null;
    const token = yield* currentToken.pipe(Effect.orElseSucceed(() => null));
    if (token === null) return null;
    const id = encodeURIComponent(route.deviceId);
    return {
      url:
        route.kind === "stream"
          ? `${hub}/api/devices/${id}/serve-sim/stream.avcc`
          : `${hub}/api/devices/${id}/serve-sim/ws`,
      headers: { authorization: `Bearer ${token}` },
      protocols: [],
      // Nothing from the browser (headers, input frames) reaches the hub.
      isolated: true,
    };
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = Effect.fn(
    "PhoneHubDeviceHost.ensureReady",
  )(function* () {
    return yield* Effect.sync(() => {
      ready ??= {
        nodePath: process.execPath,
        hub: { origin: hub },
        devices,
        upstream,
        run: () => Effect.succeed({ stdout: "", stderr: VIEW_ONLY_REASON, code: 127 }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return ready;
    });
  });

  const summary: Effect.Effect<DeviceHostSummary> = Effect.sync(() => ({
    id: hostId,
    label: PHONE_HUB_LABEL,
    kind: "simlock" as const,
    viewOnly: true,
    platforms,
    hubInstalled: true,
    agentDeviceInstalled: true,
  }));

  return DeviceHost.DeviceHost.of({
    id: hostId,
    label: PHONE_HUB_LABEL,
    summary,
    platformAvailability: Effect.fn("PhoneHubDeviceHost.platformAvailability")(function* (
      platform: DevicePlatform,
    ) {
      return yield* Effect.sync(() =>
        platform === "android"
          ? (platforms[0] ?? { platform, available: false })
          : { platform, available: false, reason: "This is an Android phone." },
      );
    }),
    ensureReady,
    ensureAgentReady: Effect.fn("PhoneHubDeviceHost.ensureAgentReady")(function* () {
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "starting agent tools",
        cause: new Error(VIEW_ONLY_REASON),
      });
    }),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    stop: Effect.sync(() => {
      ready = null;
    }),
  });
});
