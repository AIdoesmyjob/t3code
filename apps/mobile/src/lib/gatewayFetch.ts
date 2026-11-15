import { fetch as expoFetch } from "expo/fetch";

/**
 * expo/fetch with cookies. It sends none unless asked, and a sign-in gateway in front of the
 * environment (skofo: Authelia on t3.skofo.ca) needs its session cookie on every request. The
 * cookie store scopes cookies to their own domain, so other hosts see nothing new.
 */
export const fetch: typeof expoFetch = (input, init) =>
  expoFetch(input, { credentials: "include", ...init });
