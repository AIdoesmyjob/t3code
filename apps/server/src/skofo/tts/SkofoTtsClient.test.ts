// @effect-diagnostics nodeBuiltinImport:off - local test HTTP server.
import * as NodeHttp from "node:http";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { isSkofoTtsConfigured, synthesizeSkofoSpeech } from "./SkofoTtsClient.ts";

let activeServer: NodeHttp.Server | null = null;

afterEach(async () => {
  if (activeServer) {
    const server = activeServer;
    activeServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("SkofoTtsClient", () => {
  effectIt.live("reports unconfigured when config is null", () =>
    Effect.gen(function* () {
      expect(isSkofoTtsConfigured(null)).toBe(false);
      const exit = yield* Effect.exit(synthesizeSkofoSpeech({ text: "Acknowledged." }, null));
      expect(exit._tag).toBe("Failure");
    }),
  );

  effectIt.live("proxies text + bearer token to TTS backend and encodes audio bytes", () =>
    Effect.gen(function* () {
      const fakeMp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x01]);
      let seenAuth = "";
      let seenBody = "";
      activeServer = NodeHttp.createServer((req, res) => {
        seenAuth = req.headers.authorization ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          seenBody = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "Content-Type": "audio/mpeg" });
          res.end(fakeMp3);
        });
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", () => resolve())),
      );
      const address = activeServer.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const result = yield* synthesizeSkofoSpeech(
        { text: "All five machines are online.", format: "mp3" },
        { baseUrl: `http://127.0.0.1:${port}`, token: "secret-test-token" },
      );

      expect(seenAuth).toBe("Bearer secret-test-token");
      expect(JSON.parse(seenBody)).toEqual({
        text: "All five machines are online.",
        format: "mp3",
        normalize: true,
      });
      expect(result).toEqual({
        audioBase64: fakeMp3.toString("base64"),
        mimeType: "audio/mpeg",
      });
    }),
  );
});
