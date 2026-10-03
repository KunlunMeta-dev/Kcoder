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
  const stageOne = async (asset: AttachmentAsset, selectedCount: number) => {
    if (selectedCount >= MAX_ATTACHMENTS_PER_TURN)
      throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
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
    if (fileSize > MAX_ATTACHMENT_BYTES)
      throw new Error("单个附件不能超过 50 MiB");
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
    attachmentBatchRunning.current = true;
    setAttachmentLoading(true);
    setAttachmentError(null);
    const failures: string[] = [];
    try {
      const assets = await select();
      if (assets.length === 0) return;
      for (const [index, asset] of assets.entries()) {
        try {
          await stageOne(asset, attachments.length + index);
        } catch (value) {
          failures.push(
            `${asset.name}：${value instanceof Error ? value.message : String(value)}`,
          );
        }
      }
      if (!mountedRef.current) return;
      if (failures.length > 0)
        setAttachmentError(`以下附件未能添加：\n${failures.join("\n")}`);
      else setAttachmentSheet(false);
    } catch (value) {
      if (mountedRef.current)
        setAttachmentError(
          value instanceof Error ? value.message : String(value),
        );
    } finally {
      attachmentBatchRunning.current = false;
      if (mountedRef.current) setAttachmentLoading(false);
    }
  };

  const pickFile = async () => {
    await runAttachmentSelection(async () => {
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
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
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
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
      const slots = remainingAttachmentSlots(attachments.length);
      if (slots === 0)
        throw new Error(`每个回合最多添加 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error("需要相机权限才能拍照；也可以从照片图库选择图片。");
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
    try {
      if (!demo)
        await task.request("attachment/delete", { path: attachment.path });
      releaseLocalAttachmentPreview(attachment);
      setAttachments((current) =>
        current.filter((item) => item.path !== attachment.path),
      );
    } catch (value) {
      setAttachmentError(
        `无法移除 ${attachment.filename}：${value instanceof Error ? value.message : String(value)}`,
      );
    }
  };
  return {
    ...context,
    stageOne,
    runAttachmentSelection,
    pickFile,
    pickImage,
    takePhoto,
    removeAttachment,
  };
}
