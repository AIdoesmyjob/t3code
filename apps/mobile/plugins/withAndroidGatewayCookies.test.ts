import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./withAndroidGatewayCookies.cjs") as {
  registerFactory(contents: string): string;
  factorySource(packageName: string): string;
};

const MAIN_APPLICATION = `class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

describe("withAndroidGatewayCookies", () => {
  it("registers the cookie client factory right after super.onCreate()", () => {
    const patched = plugin.registerFactory(MAIN_APPLICATION);
    expect(patched).toContain(
      "super.onCreate()\n    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory(GatewayCookieClientFactory())\n    loadReactNative(this)",
    );
  });

  it("is idempotent", () => {
    const once = plugin.registerFactory(MAIN_APPLICATION);
    expect(plugin.registerFactory(once)).toBe(once);
  });

  it("fails loudly when the template loses its anchor", () => {
    expect(() => plugin.registerFactory("class MainApplication {}")).toThrow(/super.onCreate/);
  });

  it("generates the factory in the app package with a WebView-backed cookie jar", () => {
    const source = plugin.factorySource("ca.skofo.t3");
    expect(source).toMatch(/^package ca\.skofo\.t3\n/);
    expect(source).toContain("JavaNetCookieJar(ForwardingCookieHandler())");
    expect(source).toContain("ReactCookieJarContainer()");
  });
});
