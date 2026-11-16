import { describe, expect, it } from "vite-plus/test";

import { usesSharedCookieUpload } from "./gatewayUploadRoute.android";
import { usesSharedCookieUpload as usesSharedCookieUploadElsewhere } from "./gatewayUploadRoute";

describe("usesSharedCookieUpload", () => {
  it("is for HTTPS environments on Android only", () => {
    expect(usesSharedCookieUpload("https://t3.skofo.ca/api/attachments/upload/x")).toBe(true);
    expect(usesSharedCookieUpload("http://10.2.2.236:4141/api/attachments/upload/x")).toBe(false);
    expect(usesSharedCookieUploadElsewhere("https://t3.skofo.ca/api/attachments/upload/x")).toBe(
      false,
    );
  });
});
