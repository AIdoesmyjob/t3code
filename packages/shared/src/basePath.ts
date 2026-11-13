/**
 * `pathname` resolved under a base URL's own path. An environment usually sits
 * at its origin's root, but one reached through another environment's relay
 * sits under `/linked/<environmentId>/`, so a root-relative server path must
 * keep that prefix.
 */
export function urlUnderBase(baseUrl: string | URL, pathname: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url;
}

/** A server's root-relative URL (`/api/…?…`) resolved under the base; other URLs as usual. */
export function resolveUnderBase(baseUrl: string | URL, relativeUrl: string): URL {
  if (!relativeUrl.startsWith("/") || relativeUrl.startsWith("//")) {
    return new URL(relativeUrl, baseUrl);
  }
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  return new URL(`${prefix}${relativeUrl}`, base);
}
