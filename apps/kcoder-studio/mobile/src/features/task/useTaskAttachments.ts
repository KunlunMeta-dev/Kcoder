import { useEffect, useRef } from "react";
import { t } from "@/i18n";
import {
  MAX_ATTACHMENTS_PER_TURN,
  remainingAttachmentSlots,
} from "@/components/attachment-selection";
import {
  MAX_ATTACHMENT_BYTES,
  uploadStagedAttachment,
} from "@/components/attachment-upload";
import { type StagedAttachment } from "@/runtime/task-runtime";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile } from "expo-file-system";
import { EncodingType, readAsStringAsync } from "expo-file-system/legacy";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import {
  compressWebImage,
  previewableRasterMimeType,
  releaseLocalAttachmentPreview,
  webBase64Blob,
  webBlobBase64,
} from "./attachmentPreparation";
import { type AttachmentAsset } from "./types";
import type { useTaskHistory } from "./useTaskHistory";
import { useRetainedAttachmentOutbox, type RetainedAttachmentSelection } from "./useRetainedAttachmentOutbox";

export function useTaskAttachments(context: ReturnType<typeof useTaskHistory>) {
  const {
    task,
    demo,
    attachments,
    setAttachments,
    mountedRef,
    setAttachmentSheet,
    setAttachmentLoading,
    attachmentBatchRunning,
    setAttachmentError,
  } = context;
  const retainedOutbox = useRetainedAttachmentOutbox(context);
  const selectionBatch = useRef<{ owner: object } | null>(null);
  // Invalidate A before any B handler can run; stale A finally cannot release B.
  if (selectionBatch.current && selectionBatch.current.owner !== retainedOutbox.pickerOwner) {
    selectionBatch.current = null;
    attachmentBatchRunning.current = false;
  }
  useEffect(() => {
    if (!selectionBatch.current) setAttachmentLoading(false);
  }, [retainedOutbox.pickerOwner]);
  const stageOne = async (asset: AttachmentAsset, selectedCount: number, retained: RetainedAttachmentSelection | null = retainedOutbox.captureSelection(), isSelectionCurrent: () => boolean = retainedOutbox.isPickerOwnerCurrent) => {
    if (!isSelectionCurrent()) throw new Error("附件所属连接已变化，请回到原任务继续。");
    if (retained && !retained.isCurrent()) throw new Error("附件所属连接已变化，请回到原任务继续。");
    if (selectedCount >= MAX_ATTACHMENTS_PER_TURN)
      throw new Error(
        t("task.a_turn_can_have_at_most_attachments", {
          p0: MAX_ATTACHMENTS_PER_TURN,
        }),
      );
    let filename = asset.name || `attachment-${Date.now()}`;
    let mimeType = asset.mimeType || "application/octet-stream";
    let sourceUri = asset.uri;
    let localFile = Platform.OS === "web" ? null : new ExpoFile(sourceUri);
    let webBlob =
      Platform.OS === "web"
        ? (asset.blob ??
          (asset.base64
            ? webBase64Blob(asset.base64, mimeType)
            : await (await fetch(sourceUri)).blob()))
        : null;
    let fileSize = asset.size ?? webBlob?.size ?? localFile?.size ?? 0;
    if (
      Platform.OS === "web" &&
      webBlob &&
      fileSize > 256 * 1024 &&
      previewableRasterMimeType(mimeType) &&
      mimeType !== "image/gif"
    ) {
      const originalBlob = webBlob;
      webBlob = await compressWebImage(originalBlob);
      fileSize = webBlob.size;
      if (webBlob !== originalBlob) {
        mimeType = "image/jpeg";
        filename = `${filename.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
      }
    }
    if (
      Platform.OS !== "web" &&
      fileSize > 256 * 1024 &&
      previewableRasterMimeType(mimeType) &&
      mimeType !== "image/gif"
    ) {
      const variants = [
        { width: 1600, quality: 0.72 },
        { width: 1280, quality: 0.55 },
        { width: 960, quality: 0.38 },
        { width: 768, quality: 0.24 },
      ];
      for (const variant of variants) {
        const compressed = await manipulateAsync(
          sourceUri,
          [{ resize: { width: variant.width } }],
          { compress: variant.quality, format: SaveFormat.JPEG },
        );
        const candidate = new ExpoFile(compressed.uri);
        sourceUri = compressed.uri;
        localFile = candidate;
        fileSize = candidate.size ?? 0;
        mimeType = "image/jpeg";
        filename = `${filename.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
        if (fileSize <= 256 * 1024) break;
      }
    }
    if (!isSelectionCurrent()) throw new Error("附件所属连接已变化，请回到原任务继续。");
    if (fileSize > MAX_ATTACHMENT_BYTES)
      throw new Error(t("task.an_attachment_cannot_exceed_50_mib"));
    if (retained) {
      if (!retained.isCurrent() || !webBlob) throw new Error("附件所属连接已变化，请回到原任务继续。");
      await retained.stage(filename, mimeType, webBlob);
      return;
    }
    let path = `/demo/attachments/${filename}`;
    if (!demo) {
      const readBase64Chunk =
        Platform.OS === "web"
          ? async (offset: number, length: number) =>
              webBlobBase64(
                (webBlob ?? new Blob()).slice(offset, offset + length),
              )
          : async (offset: number, length: number) =>
              readAsStringAsync(sourceUri, {
                encoding: EncodingType.Base64,
                position: offset,
                length,
              });
      path = await uploadStagedAttachment(
        task.request.bind(task),
        filename,
        fileSize,
        readBase64Chunk,
      );
      if (!mountedRef.current) {
        await task.request("attachment/delete", { path }).catch(() => {});
        return;
      }
    }
    const previewMime = previewableRasterMimeType(mimeType);
    const localPreviewUri = previewMime
      ? Platform.OS === "web" && webBlob && globalThis.URL?.createObjectURL
        ? globalThis.URL.createObjectURL(webBlob)
        : sourceUri
      : undefined;
    setAttachments((current) => [
      ...current,
      {
        filename,
        mimeType,
        fileSize,
        path,
        localPreviewUri,
        ownsLocalPreviewUri: Boolean(localPreviewUri && Platform.OS === "web"),
      },
    ]);
  };

  const runAttachmentSelection = async (
    select: () => Promise<AttachmentAsset[]>,
  ) => {
    if (attachmentBatchRunning.current) return;
    const batch = { owner: retainedOutbox.pickerOwner };
    selectionBatch.current = batch;
    const isBatchCurrent = () => selectionBatch.current === batch && retainedOutbox.isPickerOwnerCurrent();
    attachmentBatchRunning.current = true;
    setAttachmentLoading(true);
    setAttachmentError(null);
    const failures: string[] = [];
    let retained: RetainedAttachmentSelection | null = null;
    try {
      // Malformed negotiated admission is a visible failure, never legacy fallback.
      retained = retainedOutbox.captureSelection();
      const assets = await select();
      if (!isBatchCurrent() || (retained && !retained.isCurrent()) || assets.length === 0) return;
      for (const [index, asset] of assets.entries()) {
        if (!isBatchCurrent()) return;
        try {
          await stageOne(asset, attachments.length + retainedOutbox.rows.length + index, retained, isBatchCurrent);
        } catch (value) {
          failures.push(`${asset.name}：${value instanceof Error ? value.message : String(value)}`);
        }
      }
      if (!isBatchCurrent()) return;
      if (failures.length > 0) setAttachmentError(t("task.could_not_add_these_attachments", { p0: failures.join("\n") }));
      else setAttachmentSheet(false);
    } catch (value) {
      if (isBatchCurrent()) setAttachmentError(value instanceof Error ? value.message : String(value));
    } finally {
      if (selectionBatch.current === batch) {
        selectionBatch.current = null;
        attachmentBatchRunning.current = false;
        if (retainedOutbox.isPickerOwnerCurrent()) setAttachmentLoading(false);
      }
    }
  };

  const pickFile = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length + retainedOutbox.rows.length);
      if (slots === 0)
        throw new Error(
          t("task.a_turn_can_have_at_most_attachments", {
            p0: MAX_ATTACHMENTS_PER_TURN,
          }),
        );
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      return (result.assets ?? []).slice(0, slots).map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        blob: asset.file,
      }));
    });
  };

  const pickImage = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length + retainedOutbox.rows.length);
      if (slots === 0)
        throw new Error(
          t("task.a_turn_can_have_at_most_attachments", {
            p0: MAX_ATTACHMENTS_PER_TURN,
          }),
        );
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        base64: Platform.OS === "web",
        allowsMultipleSelection: true,
        selectionLimit: slots,
      });
      return (result.assets ?? []).slice(0, slots).map((asset, index) => ({
        uri: asset.uri,
        name: asset.fileName ?? `image-${Date.now()}-${index + 1}.jpg`,
        mimeType: asset.mimeType,
        size: asset.fileSize,
        base64: asset.base64,
      }));
    });
  };

  const takePhoto = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length + retainedOutbox.rows.length);
      if (slots === 0)
        throw new Error(
          t("task.a_turn_can_have_at_most_attachments", {
            p0: MAX_ATTACHMENTS_PER_TURN,
          }),
        );
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          t("task.camera_permission_is_required_to_take_photos_you"),
        );
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        base64: Platform.OS === "web",
      });
      const asset = result.assets?.[0];
      return asset
        ? [
            {
              uri: asset.uri,
              name: asset.fileName ?? `camera-${Date.now()}.jpg`,
              mimeType: asset.mimeType,
              size: asset.fileSize,
              base64: asset.base64,
            },
          ]
        : [];
    });
  };

  const removeAttachment = async (attachment: StagedAttachment) => {
    setAttachmentError(null);
    if (context.pendingAttachmentSubmissions.current.has(attachment.path)) {
      context.removedPendingAttachments.current.add(attachment.path);
      setAttachments((current) =>
        current.filter((item) => item.path !== attachment.path),
      );
      return;
    }
    try {
      if (!demo)
        await task.request("attachment/delete", { path: attachment.path });
      releaseLocalAttachmentPreview(attachment);
      setAttachments((current) =>
        current.filter((item) => item.path !== attachment.path),
      );
    } catch (value) {
      setAttachmentError(
        t("task.unable_to_remove", {
          p0: attachment.filename,
          p1: value instanceof Error ? value.message : String(value),
        }),
      );
    }
  };
  return {
    ...context,
    retainedOutbox,
    stageOne,
    runAttachmentSelection,
    pickFile,
    pickImage,
    takePhoto,
    removeAttachment,
  };
}
