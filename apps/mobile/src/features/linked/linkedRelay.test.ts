import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canOpenThroughRelay,
  isLinkHost,
  isRelayBrowserSession,
  linkedRelayBaseUrls,
} from "./linkedRelay";

const RESEARCH = EnvironmentId.make("df7c9b69-44c6-477b-b691-4a8837d899c8");

describe("linkedRelayBaseUrls", () => {
  it("puts the machine under the host's /linked/<id>/ relay, for HTTP and WebSocket", () => {
    expect(linkedRelayBaseUrls("https://t3.skofo.ca/", RESEARCH)).toEqual({
      httpBaseUrl: `https://t3.skofo.ca/linked/${RESEARCH}/`,
      wsBaseUrl: `wss://t3.skofo.ca/linked/${RESEARCH}/`,
    });
  });
});

describe("isLinkHost", () => {
  it("takes direct HTTPS hosts only", () => {
    expect(isLinkHost({ httpBaseUrl: "https://t3.skofo.ca/" })).toBe(true);
    expect(isLinkHost({ httpBaseUrl: "http://10.2.2.236:4141/" })).toBe(false);
    expect(isLinkHost({ httpBaseUrl: "https://relay.example/", relayManaged: true })).toBe(false);
    expect(isLinkHost({ httpBaseUrl: `https://t3.skofo.ca/linked/${RESEARCH}/` })).toBe(false);
  });
});

describe("canOpenThroughRelay", () => {
  const link = (overrides: Partial<PeerLinkSummary>) => ({ ...overrides }) as PeerLinkSummary;
  it("needs a reachable link that offers the relay", () => {
    expect(canOpenThroughRelay(link({ browserRelay: true, status: "reachable" }))).toBe(true);
    expect(canOpenThroughRelay(link({ browserRelay: true, status: "unreachable" }))).toBe(false);
    expect(canOpenThroughRelay(link({ status: "reachable" }))).toBe(false);
  });
});

describe("isRelayBrowserSession", () => {
  it("accepts only a cookie sign-in that may manage access", () => {
    const cookie = {
      authenticated: true,
      sessionMethod: "browser-session-cookie",
      scopes: ["orchestration:read", "access:write"],
    };
    expect(isRelayBrowserSession(cookie)).toBe(true);
    expect(isRelayBrowserSession({ ...cookie, sessionMethod: "bearer-access-token" })).toBe(false);
    expect(isRelayBrowserSession({ ...cookie, scopes: ["orchestration:read"] })).toBe(false);
    expect(isRelayBrowserSession({ authenticated: false })).toBe(false);
    expect(isRelayBrowserSession(null)).toBe(false);
  });
});
