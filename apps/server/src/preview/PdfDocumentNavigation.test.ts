import type { CDPSession } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { installPdfDocumentNavigation } from "./PdfDocumentNavigation.ts";

const source = "https://environment.test/api/assets/signed-token/files/Study%20guide.PDF";

function fixture(nativePdfViewer = false) {
  const completed = Promise.withResolvers<{ method: string; params: Record<string, unknown> }>();
  let paused: (event: {
    requestId: string;
    frameId: string;
    resourceType: string;
    request: { url: string; method: string };
    responseStatusCode: number;
    responseHeaders: Array<{ name: string; value: string }>;
  }) => void = () => {
    throw new Error("Navigation handler was not installed");
  };
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Runtime.evaluate") return { result: { value: nativePdfViewer } };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (
      method === "Fetch.fulfillRequest" ||
      method === "Fetch.continueRequest" ||
      method === "Fetch.failRequest"
    ) {
      completed.resolve({ method, params });
    }
    return {};
  });
  const cdp = {
    send,
    on: (_name: string, listener: typeof paused) => {
      paused = listener;
    },
  } as unknown as CDPSession;
  return {
    cdp,
    send,
    navigate: (
      url = source,
      frameId = "main",
      method = "GET",
      status = 200,
      contentType = "application/pdf",
    ) => {
      paused({
        requestId: "request-1",
        frameId,
        resourceType: "Document",
        request: { url, method },
        responseStatusCode: status,
        responseHeaders: [{ name: "Content-Type", value: contentType }],
      });
      return completed.promise;
    },
  };
}

describe("PDF document navigation", () => {
  it("escapes filenames in the browser document", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    const result = await test.navigate(
      "https://environment.test/api/assets/token/%3Cscript%3E.pdf",
    );
    expect(Buffer.from(String(result.params.body), "base64").toString()).toContain(
      "<title>&lt;script>.pdf</title>",
    );
  });

  it("resumes navigation when committing the document fails", async () => {
    const test = fixture();
    await installPdfDocumentNavigation(test.cdp);
    test.send.mockRejectedValueOnce(new Error("Tab closed"));
    expect(await test.navigate()).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
  });
});

function routingFixture(options: {
  readonly nativePdfViewer?: boolean;
  readonly localToken?: boolean;
  readonly response?: Response;
}) {
  const completed = Promise.withResolvers<{ method: string; params: Record<string, unknown> }>();
  let paused: (event: Record<string, unknown>) => void = () => {
    throw new Error("Navigation handler was not installed");
  };
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Runtime.evaluate")
      return { result: { value: options.nativePdfViewer ?? false } };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (
      method === "Fetch.fulfillRequest" ||
      method === "Fetch.continueRequest" ||
      method === "Fetch.failRequest"
    ) {
      completed.resolve({ method, params });
    }
    return {};
  });
  const fetch = vi.fn(
    async (_input: URL | string, _init?: RequestInit) =>
      options.response ??
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
  );
  const cdp = {
    send,
    on: (_name: string, listener: typeof paused) => {
      paused = listener;
    },
  } as unknown as CDPSession;
  return {
    cdp,
    send,
    fetch,
    routing: {
      localOrigin: "http://10.0.0.5:4141",
      isLocalToken: async () => options.localToken ?? true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    },
    request: (input: {
      readonly url?: string;
      readonly resourceType?: string;
      readonly frameId?: string;
      readonly headers?: Record<string, string>;
    }) => {
      paused({
        requestId: "request-1",
        frameId: input.frameId ?? "main",
        resourceType: input.resourceType ?? "Document",
        request: {
          url: input.url ?? "https://t3.example.com/api/assets/payload.sig/files/Quote.pdf",
          method: "GET",
          headers: input.headers ?? {},
        },
      });
      return completed.promise;
    },
  };
}

describe("local asset routing", () => {
  it("loads this server's PDF from its listener and commits the client document", async () => {
    const test = routingFixture({});
    await installPdfDocumentNavigation(test.cdp, test.routing);
    const result = await test.request({});
    expect(String(test.fetch.mock.calls[0]?.[0])).toBe(
      "http://10.0.0.5:4141/api/assets/payload.sig/files/Quote.pdf",
    );
    expect(result.method).toBe("Fetch.fulfillRequest");
    expect(Buffer.from(String(result.params.body), "base64").toString()).toContain(
      "<title>Quote.pdf</title>",
    );
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/assets/*", requestStage: "Request" },
        { urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Response" },
      ],
    });
  });

  it("passes subresource bytes through and clamps open-ended ranges", async () => {
    const test = routingFixture({
      response: new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/3" },
      }),
    });
    await installPdfDocumentNavigation(test.cdp, test.routing);
    const result = await test.request({
      url: "https://t3.example.com/api/assets/payload.sig/clip.mp4",
      resourceType: "Media",
      headers: { Range: "bytes=0-", Cookie: "session=secret" },
    });
    const init = test.fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("range")).toBe(`bytes=0-${8 * 1024 * 1024 - 1}`);
    expect(headers.get("cookie")).toBeNull();
    expect(result.method).toBe("Fetch.fulfillRequest");
    expect(result.params.responseCode).toBe(206);
    expect(Buffer.from(String(result.params.body), "base64")).toEqual(Buffer.from([1, 2, 3]));
  });

  it("leaves assets signed by another server untouched", async () => {
    const test = routingFixture({ localToken: false });
    await installPdfDocumentNavigation(test.cdp, test.routing);
    expect(await test.request({})).toEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "request-1" },
    });
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("leaves requests already on the local origin untouched", async () => {
    const test = routingFixture({});
    await installPdfDocumentNavigation(test.cdp, test.routing);
    await test.request({ url: "http://10.0.0.5:4141/api/assets/payload.sig/Quote.pdf" });
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("fails a PDF navigation the local server rejects", async () => {
    const test = routingFixture({ response: new Response("Not Found", { status: 404 }) });
    await installPdfDocumentNavigation(test.cdp, test.routing);
    expect((await test.request({})).method).toBe("Fetch.failRequest");
  });

  it("routes assets even when the browser renders PDFs itself", async () => {
    const test = routingFixture({ nativePdfViewer: true });
    await installPdfDocumentNavigation(test.cdp, test.routing);
    const result = await test.request({});
    expect(result.method).toBe("Fetch.fulfillRequest");
    expect(result.params.responseCode).toBe(200);
    expect(test.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*/api/assets/*", requestStage: "Request" }],
    });
  });
});
