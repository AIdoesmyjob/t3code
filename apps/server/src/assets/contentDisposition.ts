function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentContentDisposition(fileName: string): string {
  const fallback =
    fileName
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;]/g, "_")
      .trim() || "download";

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}
