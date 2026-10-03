import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { TaskRuntime, type StagedAttachment } from "@/runtime/task-runtime";
import { colors, spacing } from "@/theme";
import { Download, Paperclip, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { styles } from "./taskStyles";
import { type ComposerStagedAttachment } from "./types";
import {
  useAttachmentAccess,
  type AttachmentAccess,
} from "./useAttachmentAccess";

export function AttachmentLightbox({
  attachment,
  access,
}: {
  attachment: StagedAttachment;
  access: AttachmentAccess;
}) {
  const insets = useSafeAreaInsets();
  const previewRef = useModalFocusTrap(
    Boolean(access.previewUri),
    access.closePreview,
  );
  return (
    <Modal
      visible={Boolean(access.previewUri)}
      transparent
      animationType="fade"
      statusBarTranslucent
      accessibilityLabel={`预览 ${attachment.filename}`}
      onRequestClose={access.closePreview}
    >
      <View
        ref={previewRef}
        role="dialog"
        accessibilityViewIsModal
        style={styles.attachmentLightbox}
      >
        <Pressable
          testID="attachment-lightbox-backdrop"
          accessibilityLabel="关闭附件预览"
          onPress={access.closePreview}
          style={StyleSheet.absoluteFillObject}
        />
        {access.previewUri && !access.previewFailed ? (
          <Image
            testID="attachment-lightbox-image"
            source={{ uri: access.previewUri }}
            onError={() => {
              access.setPreviewFailed(true);
              access.setError("图片无法解码或格式不受当前设备支持");
            }}
            resizeMode="contain"
            style={styles.attachmentLightboxImage}
          />
        ) : null}
        {access.previewFailed ? (
          <Text accessibilityRole="alert" style={styles.lightboxError}>
            图片无法解码或格式不受当前设备支持
          </Text>
        ) : null}
        {access.error && !access.previewFailed ? (
          <Text accessibilityRole="alert" style={styles.lightboxError}>
            {access.error}
          </Text>
        ) : null}
        <View
          style={[
            styles.attachmentLightboxActions,
            { top: insets.top + spacing.md, right: insets.right + spacing.md },
          ]}
        >
          <Pressable
            accessibilityLabel="下载或分享附件"
            disabled={access.loading}
            accessibilityState={{
              disabled: access.loading,
              busy: access.loading,
            }}
            onPress={() => void access.download()}
            style={[
              styles.lightboxButton,
              access.loading && styles.sendDisabled,
            ]}
          >
            {access.loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Download size={20} color="#fff" />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel="关闭附件预览"
            onPress={access.closePreview}
            style={styles.lightboxButton}
          >
            <X size={20} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function StagedAttachmentChip({
  attachment,
  task,
  onRemove,
}: {
  attachment: ComposerStagedAttachment;
  task: TaskRuntime;
  onRemove(): void;
}) {
  const access = useAttachmentAccess(
    attachment,
    task,
    attachment.localPreviewUri,
  );
  return (
    <>
      <View style={styles.stagedAttachmentItem}>
        <View style={styles.attachmentChip}>
          <Pressable
            testID={`staged-attachment-${encodeURIComponent(attachment.filename)}`}
            accessibilityRole="button"
            accessibilityLabel={`${access.previewMime ? "预览" : "下载"}待发送附件 ${attachment.filename}`}
            disabled={access.loading}
            accessibilityState={{
              disabled: access.loading,
              busy: access.loading,
            }}
            onPress={() => void access.open()}
            style={styles.attachmentChipOpen}
          >
            <Paperclip size={13} color={colors.textMuted} />
            <Text numberOfLines={1} style={styles.attachmentName}>
              {attachment.filename}
            </Text>
            {access.loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`移除 ${attachment.filename}`}
            onPress={onRemove}
            hitSlop={8}
            style={styles.attachmentChipRemove}
          >
            <X size={15} color={colors.textMuted} />
          </Pressable>
        </View>
        {access.error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.stagedAttachmentError}
          >
            {access.error}
          </Text>
        ) : null}
      </View>
      <AttachmentLightbox attachment={attachment} access={access} />
    </>
  );
}

export function MessageAttachment({
  attachment,
  task,
}: {
  attachment: StagedAttachment;
  task: TaskRuntime;
}) {
  const access = useAttachmentAccess(attachment, task);
  return (
    <>
      <Pressable
        testID={`message-attachment-${encodeURIComponent(attachment.filename)}`}
        accessibilityRole="button"
        accessibilityLabel={`${access.previewMime ? "预览" : "下载"}附件 ${attachment.filename}`}
        disabled={access.loading}
        accessibilityState={{ disabled: access.loading, busy: access.loading }}
        onPress={() => void access.open()}
        style={styles.messageAttachment}
      >
        <Paperclip size={14} color={colors.textMuted} />
        <View style={styles.messageAttachmentCopy}>
          <Text numberOfLines={1} style={styles.messageAttachmentText}>
            {attachment.filename}
          </Text>
          <Text style={styles.messageAttachmentMeta}>
            {attachment.mimeType}
            {attachment.fileSize
              ? ` · ${Math.max(1, Math.ceil(attachment.fileSize / 1024))} KiB`
              : ""}
          </Text>
        </View>
        {access.loading ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Download size={16} color={colors.textMuted} />
        )}
      </Pressable>
      {access.error ? (
        <Text accessibilityRole="alert" style={styles.attachmentError}>
          {access.error}
        </Text>
      ) : null}
      <AttachmentLightbox attachment={attachment} access={access} />
    </>
  );
}
