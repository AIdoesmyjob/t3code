/**
 * Off the Android build, uploads keep Expo's native uploader: React Native's networking there
 * does not share the sign-in WebView's cookies, so switching would gain nothing.
 */
export function usesSharedCookieUpload(_url: string): boolean {
  return false;
}
