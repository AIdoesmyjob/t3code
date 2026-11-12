import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

const ASSET_PATH_PREFIX = "/api/assets/";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export const isPdfAssetUrl = (url: string) => {
  const { pathname } = new URL(url);
  return pathname.startsWith(ASSET_PATH_PREFIX) && /\.pdf$/i.test(pathname);
};

/**
 * Serves this server's signed asset URLs from its own listener. Clients mint them for the
 * origin they reach it on (a proxy's public name), which this host may not reach or may
 * put behind a sign-in page.
 */
export interface LocalAssetRouting {
  /** The origin this server listens on, reachable from its own host. */
  readonly localOrigin: string;
  /** True only for a token this server signed. Foreign servers' assets stay untouched. */
  readonly isLocalToken: (token: string) => Promise<boolean>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Larger bodies keep the original request rather than being buffered through CDP. */
const MAX_PROXIED_BYTES = 64 * 1024 * 1024;
/** Open-ended media ranges are served in chunks so a video never buffers whole. */
const OPEN_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ["range", "if-range", "accept"];
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

const assetToken = (url: URL): string | null => {
  if (!url.pathname.startsWith(ASSET_PATH_PREFIX)) return null;
  const token = url.pathname.slice(ASSET_PATH_PREFIX.length).split("/", 1)[0] ?? "";
  return token.includes(".") ? token : null;
};

/** Clamps `bytes=N-` to one chunk; other ranges pass through unchanged. */
const clampOpenRange = (range: string): string => {
  const match = /^bytes=(\d+)-$/i.exec(range.trim());
  if (!match) return range;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return range;
  return `bytes=${start}-${start + OPEN_RANGE_CHUNK_BYTES - 1}`;
};

const localAssetUrl = (url: URL, routing: LocalAssetRouting): URL | null => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const local = new URL(routing.localOrigin);
  if (url.origin === local.origin) return null;
  return new URL(`${url.pathname}${url.search}`, local);
};

type ProxiedResponse = {
  readonly status: number;
  readonly headers: Array<{ name: string; value: string }>;
  readonly contentType: string | undefined;
  readonly body: Buffer;
};

async function fetchLocalAsset(
  target: URL,
  requestHeaders: Record<string, string>,
  method: string,
  routing: LocalAssetRouting,
): Promise<ProxiedResponse | null> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.includes(lower)) continue;
    headers.set(lower, lower === "range" ? clampOpenRange(value) : value);
  }
  const response = await (routing.fetch ?? globalThis.fetch)(target, {
    method,
    headers,
    redirect: "manual",
  });
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PROXIED_BYTES) {
    await response.body?.cancel().catch(constVoid);
    return null;
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_PROXIED_BYTES) return null;
  const responseHeaders: Array<{ name: string; value: string }> = [];
  response.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.push({ name, value });
  });
  responseHeaders.push({ name: "Content-Length", value: String(body.byteLength) });
  return {
    status: response.status,
    headers: responseHeaders,
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
    body,
  };
}

const pdfPlaceholderDocument = (url: string) => {
  const name = escapeHtml(decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "PDF"));
  return {
    responseCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "text/html; charset=utf-8" },
      { name: "Cache-Control", value: "no-store" },
      { name: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
      { name: "X-Content-Type-Options", value: "nosniff" },
    ],
    body: Buffer.from(
      `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><p>This PDF is displayed in the connected client.</p></body></html>`,
    ).toString("base64"),
  };
};

type PausedRequest = {
  readonly requestId: string;
  readonly frameId: string;
  readonly resourceType?: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Record<string, string>;
  };
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
  readonly responseHeaders?: Array<{ name: string; value: string }>;
};

export async function installPdfDocumentNavigation(
  cdp: CDPSession,
  localAssets?: LocalAssetRouting,
) {
  const nativeViewer = await cdp.send("Runtime.evaluate", {
    expression: "navigator.pdfViewerEnabled",
    returnByValue: true,
  });
  const interceptPdfDocuments = nativeViewer.result?.value !== true;
  if (!interceptPdfDocuments && localAssets === undefined) return;
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const isPdfDocument = (event: PausedRequest) =>
    interceptPdfDocuments &&
    event.resourceType === "Document" &&
    event.request.method === "GET" &&
    event.frameId === frameTree.frame.id &&
    isPdfAssetUrl(event.request.url);

  // Request stage: an asset this server signed loads from its local listener.
  const routeLocalAsset = async (event: PausedRequest) => {
    const { requestId, request } = event;
    const proceed = () => cdp.send("Fetch.continueRequest", { requestId });
    const url = new URL(request.url);
    const token = assetToken(url);
    const target = localAssets === undefined ? null : localAssetUrl(url, localAssets);
    if (
      localAssets === undefined ||
      target === null ||
      token === null ||
      (request.method !== "GET" && request.method !== "HEAD") ||
      !(await localAssets.isLocalToken(token))
    ) {
      await proceed();
      return;
    }
    const response = await fetchLocalAsset(
      target,
      request.headers ?? {},
      request.method,
      localAssets,
    );
    if (response === null) {
      await proceed();
      return;
    }
    if (isPdfDocument(event)) {
      if (response.status >= 300 && response.status < 400) {
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: response.status,
          responseHeaders: response.headers,
          body: response.body.toString("base64"),
        });
        return;
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.contentType !== "application/pdf"
      ) {
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
        return;
      }
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        ...pdfPlaceholderDocument(request.url),
      });
      return;
    }
    await cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: response.status,
      responseHeaders: response.headers,
      body: response.body.toString("base64"),
    });
  };

  // Response stage: the shell cannot open PDFs. Commit a document at the
  // original URL so the client can embed its signed bytes while Back and
  // Forward keep working.
  const commitPdfDocument = async (event: PausedRequest) => {
    const { requestId, request } = event;
    const proceed = () => cdp.send("Fetch.continueRequest", { requestId });
    if (!isPdfDocument(event)) {
      await proceed();
      return;
    }
    const status = event.responseStatusCode;
    if (status === undefined || (status >= 300 && status < 400)) {
      await proceed();
      return;
    }
    const contentType = event.responseHeaders
      ?.find((header) => header.name.toLowerCase() === "content-type")
      ?.value.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (status < 200 || status >= 300 || contentType !== "application/pdf") {
      // Reach the browser's requestfailed path instead of committing a successful PDF tab.
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
      return;
    }
    await cdp.send("Fetch.fulfillRequest", { requestId, ...pdfPlaceholderDocument(request.url) });
  };

  cdp.on("Fetch.requestPaused", (event: PausedRequest) => {
    const atRequestStage =
      event.responseStatusCode === undefined && event.responseErrorReason === undefined;
    const handle =
      atRequestStage && localAssets !== undefined ? routeLocalAsset : commitPdfDocument;
    void handle(event).catch(() =>
      cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(constVoid),
    );
  });
  await cdp.send("Fetch.enable", {
    patterns: [
      ...(localAssets === undefined
        ? []
        : [{ urlPattern: "*/api/assets/*", requestStage: "Request" as const }]),
      // Only document navigations pause here; the client's PDF fetch gets the original bytes.
      ...(interceptPdfDocuments
        ? [
            {
              urlPattern: "*/api/assets/*",
              resourceType: "Document" as const,
              requestStage: "Response" as const,
            },
          ]
        : []),
    ],
  });
}
