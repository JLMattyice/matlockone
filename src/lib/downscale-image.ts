/**
 * Shrinks a phone photo before it is sent.
 *
 * A photo straight off a phone camera is four to eight megabytes, and the
 * person sending it is often on one bar of signal in somebody's basement. At
 * 2048 pixels on the long edge a photo still shows a model number on a data
 * plate, and it is a tenth of the size.
 *
 * Anything that cannot be read here — a HEIC photo in a browser without a
 * decoder, a GIF that would lose its animation — goes as it is. So does a file
 * that shrinking would not make smaller. Browser-only: it needs a canvas.
 */

const LONG_EDGE = 2048;
const QUALITY = 0.85;
/** Small enough already, if it is also within the long edge. */
const SMALL_BYTES = 1.5 * 1024 * 1024;

export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;

  let bitmap: ImageBitmap;
  try {
    // Honours the camera's rotation flag, so a portrait photo stays upright.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }

  try {
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_BYTES) return file;

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) return file;
    // JPEG has no transparency; a screenshot with see-through corners would
    // otherwise come out with black ones.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const name = `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
