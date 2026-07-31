import { describe, expect, it } from "vite-plus/test";

import { shouldOpenMarkdownFileInBrowser } from "./openFileInPreview";

describe("markdown file preview routing", () => {
  it("uses the browser for images outside the thread workspace", () => {
    expect(shouldOpenMarkdownFileInBrowser("/tmp/proof.png", null)).toBe(true);
    expect(shouldOpenMarkdownFileInBrowser("/tmp/proof.JPEG", null)).toBe(true);
  });

  it("keeps workspace images in the file preview panel", () => {
    expect(shouldOpenMarkdownFileInBrowser("assets/proof.png", "assets/proof.png")).toBe(false);
  });

  it("keeps browser documents and rejects source files", () => {
    expect(shouldOpenMarkdownFileInBrowser("report.html", "report.html")).toBe(true);
    expect(shouldOpenMarkdownFileInBrowser("report.pdf", "report.pdf")).toBe(true);
    expect(shouldOpenMarkdownFileInBrowser("src/index.ts", null)).toBe(false);
  });
});
