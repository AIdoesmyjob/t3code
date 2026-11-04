import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SPEECH_STREAM_PATH,
  SpeechStreamEvent,
} from "@t3tools/contracts";
import { SpeechService, type SpeechStream } from "./SpeechService.ts";
import { runSpeechSocket, speechStreamRouteLayer } from "./stream.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import type * as NetAddress from "effect/net/NetAddress";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));

function client(url: string) {
  const socket = new WebSocket(url);
  const events: SpeechStreamEvent[] = [];
  let waiter: ReturnType<typeof Promise.withResolvers<SpeechStreamEvent>> | undefined;
  socket.addEventListener("message", ({ data }) => {
    const event = decodeEvent(data);
    if (waiter) {
      waiter.resolve(event);
      waiter = undefined;
    } else events.push(event);
  });
  socket.addEventListener("error", () => waiter?.reject(new Error("Speech socket failed.")));
  socket.addEventListener("close", () => waiter?.reject(new Error("Speech socket closed.")));
  return {
    socket,
    next: () => {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      waiter = Promise.withResolvers<SpeechStreamEvent>();
      return waiter.promise;
    },
  };
}

const withServer = Effect.fn("test.speech.withServer")(function* (
  startStream: SpeechService["Service"]["startStream"],
  run: (url: string) => Promise<void>,
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runSpeechSocket(socket, { startStream }).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  const url = `ws://${host}:${address.port}/ws/voice`;
  yield* Effect.promise(() => run(url));
});

const routeSession = {
  sessionId: Schema.decodeSync(AuthSessionId)("speech-session"),
  subject: "speech-test",
  method: "bearer-access-token" as const,
  scopes: [AuthOrchestrationOperateScope],
  proofKeyThumbprint: "speech-proof-key",
};

const withAuthenticatedServer = Effect.fn("test.speech.withAuthenticatedServer")(function* <E, R>(
  startStream: SpeechService["Service"]["startStream"],
  awaitInvalidation: SessionStore.SessionStore["Service"]["awaitInvalidation"],
  run: (url: string) => Effect.Effect<void, E, R>,
) {
  const routes = speechStreamRouteLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: (request, use) => {
            expect(use).toBe("media");
            const credential = new URL(request.url, "http://localhost").searchParams.get(
              "credential",
            );
            if (!credential)
              return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError());
            return Effect.succeed({
              ...routeSession,
              scopes: credential === "read" ? [AuthOrchestrationReadScope] : routeSession.scopes,
            });
          },
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "speech-test",
          legacyCookieName: undefined,
          awaitInvalidation,
        }),
        Layer.mock(SpeechService)({ startStream }),
      ),
    ),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  yield* run(`http://${host}:${address.port}${SPEECH_STREAM_PATH}`);
});

it.live("rejects speech upgrades without an authenticated operating session", () => {
  let started = false;
  return withAuthenticatedServer(
    () =>
      Effect.sync(() => {
        started = true;
      }).pipe(Effect.andThen(Effect.die("must not start"))),
    () => Effect.die("must not subscribe"),
    (url) =>
      Effect.gen(function* () {
        expect((yield* HttpClient.get(url)).status).toBe(401);
        expect((yield* HttpClient.get(`${url}?credential=read`)).status).toBe(403);
        expect(started).toBe(false);
      }),
  ).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeHttpClient.layerUndici)),
  );
});

it.live("releases active speech inference when its session is revoked or cannot be verified", () =>
  Effect.gen(function* () {
    for (const verificationFailure of [false, true]) {
      const invalidated = Promise.withResolvers<void>();
      const feeding = Promise.withResolvers<void>();
      const interrupted = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const watched: unknown[][] = [];
      const stream: SpeechStream = {
        feed: () =>
          Effect.sync(() => feeding.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
          ),
        finish: Effect.die("revoked streams must not finish"),
      };
      yield* withAuthenticatedServer(
        () =>
          Effect.acquireRelease(Effect.succeed(stream), () =>
            Effect.sync(() => released.resolve()),
          ),
        (sessionId, proofKeyThumbprint) => {
          watched.push([sessionId, proofKeyThumbprint]);
          return Effect.promise(() => invalidated.promise).pipe(
            Effect.andThen(
              verificationFailure
                ? Effect.fail(
                    new SessionStore.SessionCredentialVerificationError({
                      sessionId,
                      cause: new Error("test credential store failure"),
                    }),
                  )
                : Effect.void,
            ),
          );
        },
        (url) =>
          Effect.promise(async () => {
            const connection = client(`${url.replace(/^http/, "ws")}?credential=operate`);
            const closed = new Promise<void>((resolve) =>
              connection.socket.addEventListener("close", () => resolve(), { once: true }),
            );
            try {
              expect(await connection.next()).toEqual({ type: "ready" });
              connection.socket.send(new Float32Array([0.25]));
              await feeding.promise;
              invalidated.resolve();
              await interrupted.promise;
              await released.promise;
              await closed;
              expect(watched).toEqual([[routeSession.sessionId, routeSession.proofKeyThumbprint]]);
            } finally {
              connection.socket.close();
            }
          }),
      ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
    }
  }).pipe(Effect.scoped),
);

it.live("acknowledges binary audio and returns the finalized transcript over a real socket", () => {
  const closed = Promise.withResolvers<void>();
  const received: number[] = [];
  const stream: SpeechStream = {
    feed: (bytes) =>
      Effect.sync(() => {
        received.push(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true),
        );
        return { revision: received.length, text: { committed: "hello ", tentative: "world" } };
      }),
    finish: Effect.sync(() => {
      expect(received).toEqual([0.25, 0.5]);
      return "hello world";
    }),
  };
  return withServer(
    () => Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
    async (url) => {
      const connection = client(url);
      try {
        expect(await connection.next()).toEqual({ type: "ready" });
        for (const value of [0.25, 0.5]) {
          connection.socket.send(new Float32Array([value]));
          expect(await connection.next()).toMatchObject({
            type: "update",
            text: { tentative: "world" },
          });
        }
        connection.socket.send(JSON.stringify({ type: "finish" }));
        expect(await connection.next()).toEqual({ type: "finished", text: "hello world" });
        await closed.promise;
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("releases in-flight inference after disconnect", () => {
  const feeding = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const stream: SpeechStream = {
    feed: () => Effect.sync(() => feeding.resolve()).pipe(Effect.andThen(Effect.never)),
    finish: Effect.succeed("unexpected"),
  };
  return withServer(
    () => Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
    async (url) => {
      const connection = client(url);
      try {
        await connection.next();
        connection.socket.send(new Float32Array([0.25]));
        await feeding.promise;
        connection.socket.close();
        await closed.promise;
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("processes pipelined audio before the finish command", () => {
  const firstFeed = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const received: number[] = [];
  const stream: SpeechStream = {
    feed: (bytes) =>
      Effect.promise(async () => {
        const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(
          0,
          true,
        );
        received.push(value);
        if (received.length === 1) {
          firstFeed.resolve();
          await releaseFirst.promise;
        }
        return { revision: received.length, text: null };
      }),
    finish: Effect.sync(() => {
      expect(received).toEqual([0.25, 0.5]);
      return "done";
    }),
  };
  return withServer(
    () => Effect.succeed(stream),
    async (url) => {
      const connection = client(url);
      try {
        expect(await connection.next()).toEqual({ type: "ready" });
        connection.socket.send(new Float32Array([0.25]));
        await firstFeed.promise;
        connection.socket.send(new Float32Array([0.5]));
        connection.socket.send(JSON.stringify({ type: "finish" }));
        releaseFirst.resolve();
        expect(await connection.next()).toMatchObject({ type: "update", revision: 1 });
        expect(await connection.next()).toMatchObject({ type: "update", revision: 2 });
        expect(await connection.next()).toEqual({ type: "finished", text: "done" });
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});
