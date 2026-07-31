import { describe, expect, it } from "vite-plus/test";

import { shouldOpenMarkdownFileInBrowser } from "./openFileInPreview";

describe("markdown file preview routing", () => {
  it("keeps images in the persistent file preview panel", () => {
    expect(shouldOpenMarkdownFileInBrowser("/tmp/proof.png")).toBe(false);
    expect(shouldOpenMarkdownFileInBrowser("assets/proof.JPEG")).toBe(false);
  });

  it("keeps browser documents and rejects source files", () => {
    expect(shouldOpenMarkdownFileInBrowser("report.html")).toBe(true);
    expect(shouldOpenMarkdownFileInBrowser("report.pdf")).toBe(true);
    expect(shouldOpenMarkdownFileInBrowser("src/index.ts")).toBe(false);
  });
});
