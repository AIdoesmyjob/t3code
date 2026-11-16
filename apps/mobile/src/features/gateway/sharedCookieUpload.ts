/**
 * Expo's native uploader keeps its own cookies, so a sign-in gateway (skofo: Authelia) stops it.
 * React Native's networking shares the WebView cookie store the in-app sign-in fills on Android;
 * `usesSharedCookieUpload` (gatewayUploadRoute) says when to upload through it instead.
 */
export interface SharedCookieUploadResult {
  readonly status: number;
  readonly contentType: string | null;
}

/** POSTs the file's bytes to `url` through React Native's networking (and its cookies). */
export async function uploadWithSharedCookies(input: {
  readonly fileUri: string;
  readonly url: string;
  readonly contentType: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}): Promise<SharedCookieUploadResult> {
  const blob = await (await fetch(input.fileUri)).blob();
  try {
    return await new Promise<SharedCookieUploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const settle = () => input.signal.removeEventListener("abort", abort);
      input.signal.addEventListener("abort", abort, { once: true });
      xhr.open("POST", input.url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", input.contentType);
      const onProgress = input.onProgress;
      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
        };
      }
      xhr.onload = () => {
        settle();
        resolve({ status: xhr.status, contentType: xhr.getResponseHeader("content-type") });
      };
      xhr.onerror = () => {
        settle();
        reject(new Error("The upload could not reach the server."));
      };
      xhr.onabort = () => {
        settle();
        reject(new Error("Upload cancelled."));
      };
      if (input.signal.aborted) {
        abort();
        return;
      }
      xhr.send(blob);
    });
  } finally {
    // React Native blobs hold native memory until closed.
    (blob as { close?: () => void }).close?.();
  }
}
