// @effect-diagnostics nodeBuiltinImport:off - local test HTTP server.
import * as NodeHttp from "node:http";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  fetchSkofoBeep,
  isSkofoTtsConfigured,
  synthesizeSkofoSpeech,
  transcribeSkofoAudio,
} from "./SkofoTtsClient.ts";

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
      const sttExit = yield* Effect.exit(transcribeSkofoAudio({ audioBase64: "AAAA" }, null));
      expect(sttExit._tag).toBe("Failure");
    }),
  );

  effectIt.live("proxies TTS, STT, and LCARS beep requests with bearer auth", () =>
    Effect.gen(function* () {
      const fakeMp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x01]);
      const seenPaths: string[] = [];
      let seenAuth = "";
      activeServer = NodeHttp.createServer((req, res) => {
        seenAuth = req.headers.authorization ?? "";
        seenPaths.push(req.url ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          if (req.url === "/tts" || req.url === "/beep/listen") {
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            res.end(fakeMp3);
            return;
          }
          if (req.url === "/stt") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                text: "Computer, status report.",
                language: "en",
                duration_seconds: 1.4,
                inference_ms: 92,
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", () => resolve())),
      );
      const address = activeServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const cfg = { baseUrl: `http://127.0.0.1:${port}`, token: "secret-test-token" };

      const tts = yield* synthesizeSkofoSpeech(
        { text: "All five machines are online.", format: "mp3" },
        cfg,
      );
      const stt = yield* transcribeSkofoAudio(
        { audioBase64: fakeMp3.toString("base64"), mimeType: "audio/webm", language: "en" },
        cfg,
      );
      const beep = yield* fetchSkofoBeep({ kind: "listen" }, cfg);

      expect(seenAuth).toBe("Bearer secret-test-token");
      expect(seenPaths).toEqual(["/tts", "/stt", "/beep/listen"]);
      expect(tts).toEqual({
        audioBase64: fakeMp3.toString("base64"),
        mimeType: "audio/mpeg",
      });
      expect(stt).toEqual({
        text: "Computer, status report.",
        language: "en",
        durationSeconds: 1.4,
        inferenceMs: 92,
      });
      expect(beep).toEqual({
        audioBase64: fakeMp3.toString("base64"),
        mimeType: "audio/mpeg",
      });
    }),
  );
});
