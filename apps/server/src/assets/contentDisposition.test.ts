import { describe, expect, it } from "vite-plus/test";

import { attachmentContentDisposition } from "./contentDisposition.ts";

describe("attachmentContentDisposition", () => {
  it("provides ASCII and UTF-8 filenames", () => {
    expect(attachmentContentDisposition("résumé (final).pdf")).toBe(
      "attachment; filename=\"r_sum_ (final).pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29.pdf",
    );
  });

  it("prevents filename header injection", () => {
    expect(attachmentContentDisposition("report.pdf\r\nX-Evil: yes")).toBe(
      "attachment; filename=\"report.pdf__X-Evil: yes\"; filename*=UTF-8''report.pdf%0D%0AX-Evil%3A%20yes",
    );
  });
});
