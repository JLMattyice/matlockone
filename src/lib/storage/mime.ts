/**
 * What may be uploaded, and what it is called on disk.
 *
 * The extension is chosen here from the declared MIME type rather than taken
 * from the uploaded filename, so a file called `invoice.pdf.exe` is stored as
 * whatever its content type actually says it is.
 */

const ALLOWED_MIME = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/heic", "heic"],
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx",
  ],
  ["application/msword", "doc"],
  ["application/vnd.ms-excel", "xls"],
]);

export function isAllowedMime(mime: string) {
  return ALLOWED_MIME.has(mime);
}

/** The extension a file of this type is stored under, or null if not allowed. */
export function extensionFor(mime: string) {
  return ALLOWED_MIME.get(mime) ?? null;
}
