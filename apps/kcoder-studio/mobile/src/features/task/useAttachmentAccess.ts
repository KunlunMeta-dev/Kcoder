import { t } from "@/i18n";
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
import { useEffect, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { previewableRasterMimeType } from "./attachmentPreparation";

function decodedBase64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, "");
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

export function useAttachmentAccess(
  attachment: StagedAttachment,
  task: TaskRuntime,
  localPreviewUri?: string,
) {
  const threadId = task.getSnapshot().threadId;
  const ownerRef = useRef({ task, threadId, path: attachment.path });
  if (
    ownerRef.current.task !== task ||
    ownerRef.current.threadId !== threadId ||
    ownerRef.current.path !== attachment.path
  ) {
    ownerRef.current = { task, threadId, path: attachment.path };
  }
  const owner = ownerRef.current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const isOwnerCurrent = (candidate: typeof owner) =>
    mountedRef.current &&
    ownerRef.current === candidate &&
    !candidate.task.isDisposed() &&
    candidate.task.getSnapshot().threadId === candidate.threadId;
  const [loadingState, setLoadingState] = useState<{
    owner: typeof owner;
    value: boolean;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    owner: typeof owner;
    value: string | null;
  } | null>(null);
  const [previewUriState, setPreviewUriState] = useState<{
    owner: typeof owner;
    value: string | null;
  } | null>(null);
  const [previewFailedState, setPreviewFailedState] = useState<{
    owner: typeof owner;
    value: boolean;
  } | null>(null);
  const loading = loadingState?.owner === owner ? loadingState.value : false;
  const error = errorState?.owner === owner ? errorState.value : null;
  const previewUri =
    previewUriState?.owner === owner ? previewUriState.value : null;
  const previewFailed =
    previewFailedState?.owner === owner ? previewFailedState.value : false;
  const setLoading = (value: boolean) => setLoadingState({ owner, value });
  const setError = (value: string | null) => setErrorState({ owner, value });
  const setPreviewUri = (value: string | null) =>
    setPreviewUriState({ owner, value });
  const setPreviewFailed = (value: boolean) =>
    setPreviewFailedState({ owner, value });
  const [inlinePreviewState, setInlinePreviewState] = useState<{
    owner: typeof owner;
    value: string;
  } | null>(null);
  const [inlinePreviewLoadingState, setInlinePreviewLoadingState] = useState<{
    owner: typeof owner;
    value: boolean;
  } | null>(null);
  const inlinePreviewRequestRef = useRef<{
    owner: typeof owner;
    promise: Promise<string | null>;
  } | null>(null);
  const inlinePreviewUri =
    localPreviewUri ??
    (inlinePreviewState?.owner === owner ? inlinePreviewState.value : null);
  const inlinePreviewLoading =
    inlinePreviewLoadingState?.owner === owner
      ? inlinePreviewLoadingState.value
      : false;
  const contentRef = useRef<string | null>(null);
  const contentCacheOwnerRef = useRef(owner);
  if (contentCacheOwnerRef.current !== owner) {
    contentCacheOwnerRef.current = owner;
    contentRef.current = null;
  }
  const previewMime =
    (localPreviewUri || attachment.fileSize <= DIRECT_ATTACHMENT_BYTES)
      ? previewableRasterMimeType(attachment.mimeType)
      : null;
  const closePreview = () => {
    setPreviewUri(null);
    setPreviewFailed(false);
    setError(null);
  };
  const read = async (): Promise<string | null> => {
    const requestOwner = owner;
    if (!isOwnerCurrent(requestOwner)) return null;
    if (contentRef.current) return contentRef.current;
    const result = await requestOwner.task.request<{
      contentBase64?: string;
      size?: number;
    }>("attachment/read", {
      threadId: requestOwner.threadId,
      path: requestOwner.path,
    });
    if (!isOwnerCurrent(requestOwner)) return null;
    if (!result.contentBase64)
      throw new Error(t("task.the_appserver_returned_no_attachment_content"));
    if (result.size !== undefined && result.size > 256 * 1024)
      throw new Error(
        t("task.the_attachment_exceeds_the_256_kib_preview_limit"),
      );
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
        throw new Error(
          t("task.the_appserver_returned_an_invalid_attachment_chunk"),
        );
      const bytes = toByteArray(result.contentBase64);
      if (
        result.size !== bytes.length ||
        !Number.isSafeInteger(result.totalSize) ||
        result.totalSize! < 0 ||
        result.totalSize! > MAX_ATTACHMENT_BYTES
      ) {
        throw new Error(
          t("task.the_appserver_returned_an_invalid_attachment_size"),
        );
      }
      if (expectedTotal !== null && result.totalSize !== expectedTotal)
        throw new Error(t("task.the_attachment_size_changed_during_download"));
      expectedTotal = result.totalSize!;
      if (bytes.length === 0 && !result.eof)
        throw new Error(
          t("task.the_appserver_returned_an_empty_nonfinal_attachment_chunk"),
        );
      consume(bytes);
      offset += bytes.length;
      if (result.eof) {
        if (offset !== expectedTotal)
          throw new Error(t("task.the_attachment_download_is_incomplete"));
        return;
      }
      if (offset >= expectedTotal)
        throw new Error(
          t("task.the_appserver_returned_an_invalid_attachment_end_state"),
        );
    }
  };
  const saveOrShare = async (contentBase64?: string) => {
    if (
      contentBase64 !== undefined ||
      attachment.fileSize <= DIRECT_ATTACHMENT_BYTES
    ) {
      const encoded = contentBase64 ?? (await read());
      if (!encoded) return;
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
      if (!cacheDirectory)
        throw new Error(
          t("task.no_attachment_cache_directory_is_available_on_this"),
        );
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
            dialogTitle: t("task.share", { p0: attachment.filename }),
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
    if (!cacheDirectory)
      throw new Error(
        t("task.no_attachment_cache_directory_is_available_on_this"),
      );
    const safeName =
      attachment.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
    const path = `${cacheDirectory}kcoder-${Date.now()}-${safeName}`;
    const file = new ExpoFile(path);
    file.create({ overwrite: true, intermediates: true });
    const handle = file.open();
    try {
      await readChunks((bytes) => handle.writeBytesSync(bytes));
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
          dialogTitle: t("task.share", { p0: attachment.filename }),
        });
      } finally {
        file.delete();
      }
    } else await Linking.openURL(file.uri);
  };
  const open = async () => {
    if (loading) return;
    const requestOwner = owner;
    if (!isOwnerCurrent(requestOwner)) return;
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
        if (!encoded || !isOwnerCurrent(requestOwner)) return;
        setPreviewFailed(false);
        setPreviewUri(`data:${previewMime};base64,${encoded}`);
      } else await saveOrShare();
    } catch (value) {
      if (isOwnerCurrent(requestOwner))
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (isOwnerCurrent(requestOwner)) setLoading(false);
    }
  };
  const loadInlinePreview = async (): Promise<string | null> => {
    if (!previewMime || !isOwnerCurrent(owner)) return null;
    if (localPreviewUri) return localPreviewUri;
    if (inlinePreviewState?.owner === owner) return inlinePreviewState.value;
    if (inlinePreviewRequestRef.current?.owner === owner)
      return inlinePreviewRequestRef.current.promise;

    const requestOwner = owner;
    const promise = (async () => {
      if (isOwnerCurrent(requestOwner)) {
        setInlinePreviewLoadingState({ owner: requestOwner, value: true });
        setError(null);
      }
      try {
        const result = await requestOwner.task.request<{
          contentBase64?: string;
          size?: number;
        }>("attachment/read", {
          threadId: requestOwner.threadId,
          path: requestOwner.path,
        });
        if (!isOwnerCurrent(requestOwner)) return null;
        if (!result.contentBase64)
          throw new Error(
            t("task.the_appserver_returned_no_attachment_content"),
          );
        if (
          (result.size !== undefined &&
            result.size > DIRECT_ATTACHMENT_BYTES) ||
          decodedBase64ByteLength(result.contentBase64) >
            DIRECT_ATTACHMENT_BYTES
        )
          throw new Error(
            t("task.the_attachment_exceeds_the_256_kib_preview_limit"),
          );
        const uri = `data:${previewMime};base64,${result.contentBase64.replace(/\s/g, "")}`;
        if (isOwnerCurrent(requestOwner))
          setInlinePreviewState({ owner: requestOwner, value: uri });
        return uri;
      } catch (value) {
        if (isOwnerCurrent(requestOwner))
          setError(value instanceof Error ? value.message : String(value));
        return null;
      } finally {
        if (isOwnerCurrent(requestOwner))
          setInlinePreviewLoadingState({ owner: requestOwner, value: false });
      }
    })();
    inlinePreviewRequestRef.current = { owner: requestOwner, promise };
    try {
      return await promise;
    } finally {
      if (inlinePreviewRequestRef.current?.promise === promise)
        inlinePreviewRequestRef.current = null;
    }
  };
  const showInlinePreview = () => {
    if (!isOwnerCurrent(owner)) return;
    const uri =
      localPreviewUri ??
      (inlinePreviewState?.owner === owner ? inlinePreviewState.value : null);
    if (!uri) return;
    setError(null);
    setPreviewFailed(false);
    setPreviewUri(uri);
  };
  const download = async () => {
    const requestOwner = owner;
    if (!isOwnerCurrent(requestOwner)) return;
    setLoading(true);
    setError(null);
    try {
      await saveOrShare();
    } catch (value) {
      if (isOwnerCurrent(requestOwner))
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (isOwnerCurrent(requestOwner)) setLoading(false);
    }
  };
  return {
    loading,
    error,
    previewUri,
    previewFailed,
    previewMime,
    inlinePreviewUri,
    inlinePreviewLoading,
    closePreview,
    open,
    loadInlinePreview,
    showInlinePreview,
    download,
    setError,
    setPreviewFailed,
  };
}

export type AttachmentAccess = ReturnType<typeof useAttachmentAccess>;
