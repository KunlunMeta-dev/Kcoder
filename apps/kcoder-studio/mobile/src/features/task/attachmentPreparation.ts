import { type StagedAttachment } from "@/runtime/task-runtime";
import { type ComposerStagedAttachment } from "./types";

export const PREVIEWABLE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/tiff",
]);

export function wireAttachment(
  attachment: ComposerStagedAttachment,
): StagedAttachment {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    path: attachment.path,
  };
}

export function releaseLocalAttachmentPreview(
  attachment: ComposerStagedAttachment,
): void {
  if (
    attachment.ownsLocalPreviewUri &&
    attachment.localPreviewUri &&
    globalThis.URL?.revokeObjectURL
  ) {
    globalThis.URL.revokeObjectURL(attachment.localPreviewUri);
  }
}

export function previewableRasterMimeType(value: string): string | null {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized && PREVIEWABLE_RASTER_MIME_TYPES.has(normalized)
    ? normalized
    : null;
}

export async function webBlobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("无法读取所选文件"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("浏览器未返回有效的文件内容"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function webBase64Blob(base64: string, mimeType: string): Blob {
  const normalized = base64.includes(",")
    ? base64.slice(base64.indexOf(",") + 1)
    : base64;
  const binary = globalThis.atob(normalized.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export async function compressWebImage(blob: Blob): Promise<Blob> {
  if (!globalThis.document || typeof createImageBitmap !== "function")
    return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    for (const variant of [
      { width: 1600, quality: 0.72 },
      { width: 1280, quality: 0.55 },
      { width: 960, quality: 0.38 },
      { width: 768, quality: 0.24 },
    ]) {
      const scale = Math.min(1, variant.width / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return blob;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const candidate = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", variant.quality),
      );
      if (candidate && candidate.size <= 256 * 1024) return candidate;
    }
    return blob;
  } finally {
    bitmap.close();
  }
}
