import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./withAndroidGatewayCookies.cjs") as {
  registerFactory(contents: string): string;
  factorySource(packageName: string, options?: { appMetrics?: boolean }): string;
};

const MAIN_APPLICATION = `class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}
`;

describe("withAndroidGatewayCookies", () => {
  it("installs the gateway cookie handlers after the Expo lifecycle listeners", () => {
    const patched = plugin.registerFactory(MAIN_APPLICATION);
    expect(patched).toContain(
      "ApplicationLifecycleDispatcher.onApplicationCreate(this)\n    GatewayCookieClientFactory.install()\n  }",
    );
  });

  it("is idempotent", () => {
    const once = plugin.registerFactory(MAIN_APPLICATION);
    expect(plugin.registerFactory(once)).toBe(once);
  });

  it("fails loudly when the template loses its anchor", () => {
    expect(() => plugin.registerFactory("class MainApplication {}")).toThrow(/onApplicationCreate/);
  });

  it("generates the factory in the app package with a WebView-backed cookie jar", () => {
    const source = plugin.factorySource("ca.skofo.t3");
    expect(source).toMatch(/^package ca\.skofo\.t3\n/);
    expect(source).toContain("JavaNetCookieJar(ForwardingCookieHandler())");
    expect(source).toContain("ReactCookieJarContainer()");
  });

  it("also gives HttpURLConnection (Glide's default loader) the WebView cookie store", () => {
    const source = plugin.factorySource("ca.skofo.t3");
    expect(source).toContain(
      "OkHttpClientProvider.setOkHttpClientFactory(GatewayCookieClientFactory())",
    );
    expect(source).toContain("CookieHandler.setDefault(ForwardingCookieHandler())");
  });

  it("turns an asset request redirected to the sign-in page into a 401", () => {
    const source = plugin.factorySource("ca.skofo.t3");
    expect(source).toContain(".addInterceptor(GatewayAssetRedirectInterceptor)");
    expect(source).toContain('contains("/api/assets/")');
    expect(source).toContain(".code(401)");
  });

  it("keeps expo-app-metrics' network observer only when that package is installed", () => {
    expect(plugin.factorySource("ca.skofo.t3")).not.toContain("NetworkRequestInterceptor");
    const withMetrics = plugin.factorySource("ca.skofo.t3", { appMetrics: true });
    expect(withMetrics).toContain(".addInterceptor(NetworkRequestInterceptor.instance)");
    expect(withMetrics).toContain(".eventListenerFactory(NetworkRequestEventListener.factory)");
  });
});
