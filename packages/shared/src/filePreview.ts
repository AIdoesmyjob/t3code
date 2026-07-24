export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

export const WORKSPACE_DOWNLOAD_PREFERRED_EXTENSIONS = [
  ".7z",
  ".avi",
  ".bz2",
  ".dmg",
  ".doc",
  ".docx",
  ".epub",
  ".exe",
  ".flac",
  ".gz",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rar",
  ".tar",
  ".tgz",
  ".wav",
  ".webm",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
] as const;

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}

export function isWorkspaceDownloadPreferredPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_DOWNLOAD_PREFERRED_EXTENSIONS);
}
