import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { uploadWithSharedCookies } from "./sharedCookieUpload";

class FakeXhr {
  static last: FakeXhr | null = null;
  status = 0;
  withCredentials = false;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  responseContentType: string | null = null;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === "content-type" ? this.responseContentType : null;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

const blob = { size: 3, close: vi.fn() };

beforeEach(() => {
  FakeXhr.last = null;
  blob.close.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ blob: async () => blob })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadWithSharedCookies", () => {
  const url = "https://t3.skofo.ca/api/attachments/upload/signed";

  it("POSTs the file's bytes with credentials and reports progress and the answer", async () => {
    const progress: Array<number> = [];
    const pending = uploadWithSharedCookies({
      fileUri: "file:///documents/photo.jpg",
      url,
      contentType: "image/jpeg",
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
    });
    await vi.waitFor(() => expect(FakeXhr.last?.body).toBe(blob));
    const xhr = FakeXhr.last!;
    expect(fetch).toHaveBeenCalledWith("file:///documents/photo.jpg");
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe(url);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers).toEqual({ "Content-Type": "image/jpeg" });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 } as ProgressEvent);
    xhr.status = 204;
    xhr.onload?.();
    await expect(pending).resolves.toEqual({ status: 204, contentType: null });
    expect(progress).toEqual([0.25]);
    expect(blob.close).toHaveBeenCalled();
  });

  it("aborts with the signal and still frees the blob", async () => {
    const controller = new AbortController();
    const pending = uploadWithSharedCookies({
      fileUri: "file:///documents/photo.jpg",
      url,
      contentType: "image/jpeg",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(FakeXhr.last?.body).toBe(blob));
    controller.abort();
    await expect(pending).rejects.toThrow("Upload cancelled.");
    expect(FakeXhr.last?.aborted).toBe(true);
    expect(blob.close).toHaveBeenCalled();
  });

  it("rejects when the network fails", async () => {
    const pending = uploadWithSharedCookies({
      fileUri: "file:///documents/photo.jpg",
      url,
      contentType: "image/jpeg",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(FakeXhr.last?.body).toBe(blob));
    FakeXhr.last!.onerror?.();
    await expect(pending).rejects.toThrow("could not reach the server");
  });
});
