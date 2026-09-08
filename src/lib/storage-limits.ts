/**
 * Upload limits shared by the browser and the server.
 *
 * `storage.ts` is server-only (it touches the filesystem), so the parts the
 * upload form needs to display live here instead.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function allowedExtensionsLabel() {
  return "JPG, PNG, WebP, HEIC, GIF, PDF, DOC, DOCX, XLS, XLSX, CSV, TXT";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function isImageMime(mime: string) {
  return mime.startsWith("image/");
}
