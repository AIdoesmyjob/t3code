// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off - reads optional local token file and calls configured local LAN TTS service.
import * as NodeFS from "node:fs";
import type {
  EnvironmentSpeechSynthesizeRequest,
  EnvironmentSpeechSynthesizeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  SpeechOperationError,
  SpeechUnsupportedPlatformError,
  type SpeechError,
} from "../../speech/SpeechService.ts";

interface SkofoTtsConfig {
  readonly baseUrl: string;
  readonly token: string | null;
}

const DEFAULT_TTS_URL = process.env.T3CODE_SKOFO_TTS_URL?.trim().replace(/\/+$/, "") ?? "";
const DEFAULT_TTS_TOKEN_DIRECT = process.env.T3CODE_SKOFO_TTS_TOKEN?.trim() ?? "";
const DEFAULT_TTS_TOKEN_FILE = process.env.T3CODE_SKOFO_TTS_TOKEN_FILE?.trim() ?? "";
const SYNTHESIS_TIMEOUT_MS = 30_000;

function resolveDefaultToken(): string | null {
  if (DEFAULT_TTS_TOKEN_DIRECT.length > 0) return DEFAULT_TTS_TOKEN_DIRECT;
  if (DEFAULT_TTS_TOKEN_FILE.length > 0) {
    try {
      const value = NodeFS.readFileSync(DEFAULT_TTS_TOKEN_FILE, "utf8").trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

const DEFAULT_CONFIG: SkofoTtsConfig | null =
  DEFAULT_TTS_URL.length > 0
    ? {
        baseUrl: DEFAULT_TTS_URL,
        token: resolveDefaultToken(),
      }
    : null;

export function isSkofoTtsConfigured(config: SkofoTtsConfig | null = DEFAULT_CONFIG): boolean {
  return config !== null && config.baseUrl.length > 0;
}

export function synthesizeSkofoSpeech(
  request: EnvironmentSpeechSynthesizeRequest,
  config: SkofoTtsConfig | null = DEFAULT_CONFIG,
): Effect.Effect<EnvironmentSpeechSynthesizeResult, SpeechError> {
  if (!isSkofoTtsConfigured(config) || config === null) {
    return Effect.fail(
      new SpeechUnsupportedPlatformError({
        platform: "skofo-tts",
        architecture: "unconfigured",
      }),
    );
  }
  const text = request.text.trim();
  if (text.length === 0) {
    return Effect.fail(
      new SpeechOperationError({
        operation: "synthesize",
        cause: new Error("Speech text cannot be empty."),
      }),
    );
  }
  const format = request.format ?? "mp3";
  const url = `${config.baseUrl}/tts`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  return Effect.tryPromise({
    try: async (signal) => {
      const timeout = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout]);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, format, normalize: true }),
        signal: combined,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `TTS backend returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error("TTS backend returned empty audio payload.");
      }
      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        (format === "wav" ? "audio/wav" : "audio/mpeg");
      return {
        audioBase64: Buffer.from(bytes).toString("base64"),
        mimeType: contentType,
      };
    },
    catch: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        detail.includes("fetch failed") ||
        detail.includes("ECONNREFUSED") ||
        detail.includes("EHOSTUNREACH") ||
        detail.includes("TimeoutError")
      ) {
        return new SpeechUnsupportedPlatformError({
          platform: "skofo-tts",
          architecture: "unreachable",
        });
      }
      return new SpeechOperationError({
        operation: "synthesize",
        cause: error,
      });
    },
  });
}
