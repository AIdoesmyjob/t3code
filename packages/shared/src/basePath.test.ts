import { describe, expect, it } from "vite-plus/test";

import { resolveUnderBase, urlUnderBase } from "./basePath.ts";
import { previewPdfAssetUrl } from "./preview.ts";

const RELAY = "https://t3.example/linked/env-1/";

describe("urlUnderBase", () => {
  it("keeps a root base as before", () => {
    expect(urlUnderBase("https://host.example/?a=1#x", "/api/x").href).toBe(
      "https://host.example/api/x",
    );
  });

  it("keeps a relay base's path", () => {
    expect(urlUnderBase(RELAY, "/oauth/token").href).toBe(
      "https://t3.example/linked/env-1/oauth/token",
    );
    expect(urlUnderBase("https://t3.example/linked/env-1", "api/x").href).toBe(
      "https://t3.example/linked/env-1/api/x",
    );
  });
});

describe("resolveUnderBase", () => {
  it("puts a server's root-relative URL under the relay", () => {
    expect(resolveUnderBase(RELAY, "/api/assets/a.png?sig=1").href).toBe(
      "https://t3.example/linked/env-1/api/assets/a.png?sig=1",
    );
    expect(resolveUnderBase("https://host.example/", "/api/assets/a.png").href).toBe(
      "https://host.example/api/assets/a.png",
    );
  });

  it("leaves absolute and protocol-relative URLs alone", () => {
    expect(resolveUnderBase(RELAY, "https://cdn.example/x").href).toBe("https://cdn.example/x");
    expect(resolveUnderBase(RELAY, "//cdn.example/x").href).toBe("https://cdn.example/x");
  });

  it("fetches a peer's loopback PDF through the relay", () => {
    expect(previewPdfAssetUrl("http://127.0.0.1:4141/api/assets/doc.pdf?sig=1", RELAY)).toBe(
      "https://t3.example/linked/env-1/api/assets/doc.pdf?sig=1",
    );
  });
});
