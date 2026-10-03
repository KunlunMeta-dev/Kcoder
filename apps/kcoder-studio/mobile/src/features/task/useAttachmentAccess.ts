import {
  DIRECT_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
} from "@/components/attachment-upload";
import { TaskRuntime, type StagedAttachment } from "@/runtime/task-runtime";
import { toByteArray } from "base64-js";
import { File as ExpoFile } from "expo-file-system";
import {
  cacheDirectory,
  deleteAsync,
  EncodingType,
  writeAsStringAsync,
} from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { previewableRasterMimeType } from "./attachmentPreparation";

export function useAttachmentAccess(
  attachment: StagedAttachment,
  task: TaskRuntime,
  localPreviewUri?: string,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const contentRef = useRef<string | null>(null);
  const previewMime =
    attachment.fileSize <= DIRECT_ATTACHMENT_BYTES
      ? previewableRasterMimeType(attachment.mimeType)
      : null;
  const closePreview = () => {
    setPreviewUri(null);
    setPreviewFailed(false);
    setError(null);
  };
  const read = async () => {
    if (contentRef.current) return contentRef.current;
    const result = await task.request<{
      contentBase64?: string;
      size?: number;
    }>("attachment/read", {
      threadId: task.getSnapshot().threadId,
      path: attachment.path,
    });
    if (!result.contentBase64) throw new Error("app-server 未返回附件内容");
    if (result.size !== undefined && result.size > 256 * 1024)
      throw new Error("附件超过 256 KiB 预览限制");
    contentRef.current = result.contentBase64;
    return result.contentBase64;
  };
  const readChunks = async (consume: (bytes: Uint8Array) => void) => {
    let offset = 0;
    let expectedTotal: number | null = null;
    for (;;) {
      const result = await task.request<{
        contentBase64?: string;
        offset?: number;
        size?: number;
        totalSize?: number;
        eof?: boolean;
      }>("attachment/read/chunk", {
        threadId: task.getSnapshot().threadId,
        path: attachment.path,
        offset,
        length: 512 * 1024,
      });
      if (result.offset !== offset || typeof result.contentBase64 !== "string")
        throw new Error("app-server 返回了无效的附件分片");
      const bytes = toByteArray(result.contentBase64);
      if (
        result.size !== bytes.length ||
        !Number.isSafeInteger(result.totalSize) ||
        result.totalSize! < 0 ||
        result.totalSize! > MAX_ATTACHMENT_BYTES
      ) {
        throw new Error("app-server 返回了无效的附件大小");
      }
      if (expectedTotal !== null && result.totalSize !== expectedTotal)
        throw new Error("附件下载期间大小发生变化");
      expectedTotal = result.totalSize!;
      if (bytes.length === 0 && !result.eof)
        throw new Error("app-server 返回了空的非末尾附件分片");
      consume(bytes);
      offset += bytes.length;
      if (result.eof) {
        if (offset !== expectedTotal) throw new Error("附件下载未完整结束");
        return;
      }
      if (offset >= expectedTotal)
        throw new Error("app-server 返回了无效的附件末尾状态");
    }
  };
  const saveOrShare = async (contentBase64?: string) => {
    if (
      contentBase64 !== undefined ||
      attachment.fileSize <= DIRECT_ATTACHMENT_BYTES
    ) {
      const encoded = contentBase64 ?? (await read());
      const uri = `data:${attachment.mimeType};base64,${encoded}`;
      if (Platform.OS === "web" && globalThis.document) {
        const anchor = globalThis.document.createElement("a");
        anchor.href = uri;
        anchor.download = attachment.filename;
        anchor.rel = "noopener";
        globalThis.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }
      if (!cacheDirectory) throw new Error("设备没有可用的附件缓存目录");
      const safeName =
        attachment.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
      const path = `${cacheDirectory}kcoder-${Date.now()}-${safeName}`;
      await writeAsStringAsync(path, encoded, {
        encoding: EncodingType.Base64,
      });
      if (await Sharing.isAvailableAsync()) {
        try {
          await Sharing.shareAsync(path, {
            mimeType: attachment.mimeType,
            dialogTitle: `分享 ${attachment.filename}`,
          });
        } finally {
          await deleteAsync(path, { idempotent: true });
        }
      } else await Linking.openURL(path);
      return;
    }
    if (Platform.OS === "web" && globalThis.document) {
      const chunks: ArrayBuffer[] = [];
      await readChunks((bytes) => chunks.push(Uint8Array.from(bytes).buffer));
      const url = globalThis.URL.createObjectURL(
        new Blob(chunks, { type: attachment.mimeType }),
      );
      const anchor = globalThis.document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.rel = "noopener";
      globalThis.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1_000);
      return;
    }
    if (!cacheDirectory) throw new Error("设备没有可用的附件缓存目录");
    const safeName =
      attachment.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
    const path = `${cacheDirectory}kcoder-${Date.now()}-${safeName}`;
    const file = new ExpoFile(path);
    file.create({ overwrite: true, intermediates: true });
    const handle = file.open();
    try {
      await readChunks((bytes) => handle.writeBytes(bytes));
    } catch (value) {
      handle.close();
      file.delete();
      throw value;
    }
    handle.close();
    if (await Sharing.isAvailableAsync()) {
      try {
        await Sharing.shareAsync(file.uri, {
          mimeType: attachment.mimeType,
          dialogTitle: `分享 ${attachment.filename}`,
        });
      } finally {
        file.delete();
      }
    } else await Linking.openURL(file.uri);
  };
  const open = async () => {
    if (loading) return;
    if (previewMime && localPreviewUri) {
      setError(null);
      setPreviewFailed(false);
      setPreviewUri(localPreviewUri);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (previewMime) {
        const encoded = await read();
        setPreviewFailed(false);
        setPreviewUri(`data:${previewMime};base64,${encoded}`);
      } else await saveOrShare();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };
  const download = async () => {
    setLoading(true);
    setError(null);
    try {
      await saveOrShare();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };
  return {
    loading,
    error,
    previewUri,
    previewFailed,
    previewMime,
    closePreview,
    open,
    download,
    setError,
    setPreviewFailed,
  };
}

export type AttachmentAccess = ReturnType<typeof useAttachmentAccess>;
