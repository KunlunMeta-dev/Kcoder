/** Mirrors native vision admission; transfer chunks and thumbnails have separate limits. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 8192;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
export const SMALL_IMAGE_EDGE = 32;

export function imageSizeIssue(width: number, height: number): "large" | "small" | null {
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS)
    return "large";
  if (Math.min(width, height) < SMALL_IMAGE_EDGE) return "small";
  return null;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif", heic: "image/heic",
  heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
};

/** Missing picker metadata is not evidence that an image is an opaque document. */
export function attachmentMimeType(filename: string, mime?: string | null): string {
  const normalized = mime?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream")
    return normalized === "image/jpg" ? "image/jpeg" : normalized;
  return IMAGE_EXTENSIONS[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
