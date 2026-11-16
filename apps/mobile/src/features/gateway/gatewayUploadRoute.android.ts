import { gatewayOriginOf } from "./gatewaySession";

/** HTTPS environments, the only ones a sign-in gateway can guard, upload with the shared cookies. */
export function usesSharedCookieUpload(url: string): boolean {
  return gatewayOriginOf(url) !== null;
}
