import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { TaskRuntime, type StagedAttachment } from "@/runtime/task-runtime";
import { spacing } from "@/theme";
import { Download, Paperclip, Sparkles, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTaskAppearance } from "./taskStyles";
import { type ComposerStagedAttachment } from "./types";
import {
  useAttachmentAccess,
  type AttachmentAccess,
} from "./useAttachmentAccess";

function useComposerAttachmentPreviewStyles(
  colors: ReturnType<typeof useTaskAppearance>["colors"],
) {
  return useMemo(
    () =>
      StyleSheet.create({
        list: {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          paddingTop: spacing.sm,
          paddingBottom: spacing.md,
        },
        imageItem: {
          width: 84,
          minHeight: 76,
          position: "relative",
        },
        imageOpen: {
          width: 68,
          height: 68,
          marginTop: 4,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: colors.surface,
        },
        image: { width: "100%", height: "100%" },
        imageFallback: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        },
        removeImage: {
          position: "absolute",
          top: 0,
          right: 0,
          zIndex: 1,
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surfaceRaised,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        fileItem: {
          width: 220,
          minHeight: 64,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: spacing.md,
          paddingRight: spacing.xs,
          gap: spacing.sm,
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        fileOpen: {
          flex: 1,
          minWidth: 0,
          minHeight: 64,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
        },
        fileCopy: { flex: 1, minWidth: 0 },
        fileName: { color: colors.text, fontSize: 12, lineHeight: 16 },
        fileMeta: { color: colors.textDim, fontSize: 10, lineHeight: 14 },
        removeFile: {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 22,
        },
        itemError: {
          width: 220,
          color: colors.red,
          fontSize: 10,
          lineHeight: 14,
          marginTop: spacing.xs,
        },
        imageError: {
          width: 84,
          color: colors.red,
          fontSize: 10,
          lineHeight: 14,
          marginTop: spacing.xs,
        },
        messageImage: {
          width: 220,
          height: 164,
          maxWidth: "100%",
          marginTop: spacing.xs,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: colors.surface,
        },
        messageImageLoading: {
          width: 220,
          height: 164,
          maxWidth: "100%",
          marginTop: spacing.xs,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: colors.surface,
        },
        sendDisabled: { opacity: 0.45 },
      }),
    [colors],
  );
}

export function AttachmentLightbox({
  attachment,
  access,
}: {
  attachment: StagedAttachment;
  access: AttachmentAccess;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
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
      accessibilityLabel={t("task.preview_with_value", {
        p0: attachment.filename,
      })}
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
          accessibilityLabel={t("task.close_attachment_preview")}
          onPress={access.closePreview}
          style={StyleSheet.absoluteFill}
        />
        {access.previewUri && !access.previewFailed ? (
          <Image
            testID="attachment-lightbox-image"
            source={{ uri: access.previewUri }}
            onError={() => {
              access.setPreviewFailed(true);
              access.setError(
                t("task.the_image_cannot_be_decoded_or_its_format"),
              );
            }}
            resizeMode="contain"
            style={styles.attachmentLightboxImage}
          />
        ) : null}
        {access.previewFailed ? (
          <Text accessibilityRole="alert" style={styles.lightboxError}>
            {t("task.the_image_cannot_be_decoded_or_its_format")}
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
            accessibilityLabel={t("task.download_or_share_attachment")}
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
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Download size={20} color={colors.text} />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel={t("task.close_attachment_preview")}
            onPress={access.closePreview}
            style={styles.lightboxButton}
          >
            <X size={20} color={colors.text} />
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
  removeDisabled = false,
}: {
  attachment: ComposerStagedAttachment;
  task: TaskRuntime;
  onRemove(): void;
  removeDisabled?: boolean;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
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
            accessibilityLabel={t("task.staged_attachment", {
              p0: access.previewMime ? t("task.preview") : t("task.download"),
              p1: attachment.filename,
            })}
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
            accessibilityLabel={t("task.remove_attachment", {
              p0: attachment.filename,
            })}
            disabled={removeDisabled}
            accessibilityState={{ disabled: removeDisabled }}
            onPress={onRemove}
            hitSlop={8}
            style={[
              styles.attachmentChipRemove,
              removeDisabled && styles.sendDisabled,
            ]}
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

function ComposerAttachmentPreviewItem({
  attachment,
  task,
  onRemove,
  removeDisabled,
}: {
  attachment: ComposerStagedAttachment;
  task: TaskRuntime;
  onRemove(): void;
  removeDisabled: boolean;
}) {
  const { colors } = useTaskAppearance();
  const styles = useComposerAttachmentPreviewStyles(colors);
  const access = useAttachmentAccess(
    attachment,
    task,
    attachment.localPreviewUri,
  );
  const isImage = Boolean(access.previewMime && access.inlinePreviewUri);
  const remove = (
    image: boolean,
  ) => (
    <Pressable
      testID={`composer-remove-attachment-${encodeURIComponent(attachment.filename)}`}
      accessibilityRole="button"
      accessibilityLabel={t("task.remove_attachment", {
        p0: attachment.filename,
      })}
      disabled={removeDisabled}
      accessibilityState={{ disabled: removeDisabled }}
      onPress={onRemove}
      style={[
        image ? styles.removeImage : styles.removeFile,
        removeDisabled && styles.sendDisabled,
      ]}
    >
      <X size={16} color={colors.textMuted} />
    </Pressable>
  );
  const content = isImage ? (
    <View
      testID={`composer-image-attachment-${encodeURIComponent(attachment.filename)}`}
      style={styles.imageItem}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.staged_attachment", {
          p0: t("task.preview"),
          p1: attachment.filename,
        })}
        disabled={access.loading}
        accessibilityState={{
          disabled: access.loading,
          busy: access.loading,
        }}
        onPress={() => void access.open()}
        style={styles.imageOpen}
      >
        {access.inlinePreviewUri && !access.previewFailed ? (
          <Image
            source={{ uri: access.inlinePreviewUri }}
            resizeMode="cover"
            style={styles.image}
            onError={() => {
              access.setPreviewFailed(true);
              access.setError(
                t("task.the_image_cannot_be_decoded_or_its_format"),
              );
            }}
          />
        ) : (
          <View style={styles.imageFallback}>
            {access.loading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Paperclip size={20} color={colors.textMuted} />
            )}
          </View>
        )}
      </Pressable>
      {remove(true)}
      {access.error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.imageError}
        >
          {access.error}
        </Text>
      ) : null}
      <AttachmentLightbox attachment={attachment} access={access} />
    </View>
  ) : (
    <View>
      <View style={styles.fileItem}>
        <Pressable
          testID={`composer-file-attachment-${encodeURIComponent(attachment.filename)}`}
          accessibilityRole="button"
          accessibilityLabel={t("task.staged_attachment", {
            p0: access.previewMime ? t("task.preview") : t("task.download"),
            p1: attachment.filename,
          })}
          disabled={access.loading}
          accessibilityState={{
            disabled: access.loading,
            busy: access.loading,
          }}
          onPress={() => void access.open()}
          style={styles.fileOpen}
        >
          <Paperclip size={16} color={colors.textMuted} />
          <View style={styles.fileCopy}>
            <Text numberOfLines={1} style={styles.fileName}>
              {attachment.filename}
            </Text>
            <Text numberOfLines={1} style={styles.fileMeta}>
              {attachment.mimeType}
              {attachment.fileSize
                ? ` · ${Math.max(1, Math.ceil(attachment.fileSize / 1024))} KiB`
                : ""}
            </Text>
          </View>
          {access.loading ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : null}
        </Pressable>
        {remove(false)}
      </View>
      {access.error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.itemError}
        >
          {access.error}
        </Text>
      ) : null}
      <AttachmentLightbox attachment={attachment} access={access} />
    </View>
  );
  return content;
}

export function ComposerAttachmentPreview({
  attachments,
  task,
  onRemove,
  removeDisabled = false,
}: {
  attachments: ComposerStagedAttachment[];
  task: TaskRuntime;
  onRemove(attachment: ComposerStagedAttachment): void;
  removeDisabled?: boolean;
}) {
  useLocale();
  const { colors } = useTaskAppearance();
  const styles = useComposerAttachmentPreviewStyles(colors);
  if (attachments.length === 0) return null;
  const threadId = task.getSnapshot().threadId;
  return (
    <ScrollView
      testID="composer-attachment-preview-list"
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.list}
    >
      {attachments.map((attachment) => (
        <ComposerAttachmentPreviewItem
          key={`${threadId}:${attachment.path}`}
          attachment={attachment}
          task={task}
          onRemove={() => onRemove(attachment)}
          removeDisabled={removeDisabled}
        />
      ))}
    </ScrollView>
  );
}

export function MessageAttachment({
  attachment,
  task,
  inlineImage = false,
}: {
  attachment: StagedAttachment;
  task: TaskRuntime;
  inlineImage?: boolean;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const previewStyles = useComposerAttachmentPreviewStyles(colors);
  const access = useAttachmentAccess(attachment, task);
  const threadId = task.getSnapshot().threadId;
  const loadPreviewRef = useRef(access.loadInlinePreview);
  loadPreviewRef.current = access.loadInlinePreview;
  useEffect(() => {
    if (inlineImage && access.previewMime)
      void loadPreviewRef.current();
  }, [inlineImage, task, threadId, attachment.path, access.previewMime]);
  const showImagePreview = Boolean(
    inlineImage &&
      access.previewMime &&
      access.inlinePreviewUri &&
      !access.previewFailed,
  );
  return (
    <>
      {showImagePreview ? (
        <Pressable
          testID={`message-image-attachment-${encodeURIComponent(attachment.filename)}`}
          accessibilityRole="button"
          accessibilityLabel={t("task.attachment", {
            p0: t("task.preview"),
            p1: attachment.filename,
          })}
          onPress={access.showInlinePreview}
          style={previewStyles.messageImage}
        >
          <Image
            source={{ uri: access.inlinePreviewUri! }}
            resizeMode="cover"
            style={previewStyles.image}
            onError={() => {
              access.setPreviewFailed(true);
              access.setError(
                t("task.the_image_cannot_be_decoded_or_its_format"),
              );
            }}
          />
        </Pressable>
      ) : inlineImage && access.previewMime && access.inlinePreviewLoading ? (
        <View
          testID={`message-image-attachment-loading-${encodeURIComponent(attachment.filename)}`}
          style={previewStyles.messageImageLoading}
        >
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : (
        <Pressable
          testID={`message-attachment-${encodeURIComponent(attachment.filename)}`}
          accessibilityRole="button"
          accessibilityLabel={t("task.attachment", {
            p0: access.previewMime ? t("task.preview") : t("task.download"),
            p1: attachment.filename,
          })}
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
      )}
      {access.error ? (
        <Text accessibilityRole="alert" style={styles.attachmentError}>
          {access.error}
        </Text>
      ) : null}
      <AttachmentLightbox attachment={attachment} access={access} />
    </>
  );
}

/** Local draft preview does not read an app-server path or fabricate a task runtime. */
export function LocalDraftAttachmentPreview({ items, disabled, onRemove }: {
  items: import("./useNewTaskDraftAttachments").DraftLocalAttachment[];
  disabled: boolean;
  onRemove(id: string): void;
}) {
  const { styles: taskStyles, colors } = useTaskAppearance();
  const styles = useComposerAttachmentPreviewStyles(colors);
  const [opened, setOpened] = useState<string | null>(null);
  const selected = items.find(item => item.id === opened);
  const close = () => setOpened(null);
  const modalRef = useModalFocusTrap(Boolean(selected), close);
  return <>
    <ScrollView testID="draft-local-attachment-preview" horizontal contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      {items.map(item => <View key={item.id} style={item.previewUri ? styles.imageItem : styles.fileItem}>
        {item.previewUri ? <Pressable testID={`composer-image-attachment-${encodeURIComponent(item.filename)}`} onPress={() => setOpened(item.id)}
          accessibilityRole="button" accessibilityLabel={t("task.preview")} style={styles.imageOpen}>
          <Image source={{ uri: item.previewUri }} resizeMode="cover" style={styles.image} />
        </Pressable> : <View style={styles.fileCopy}><Text numberOfLines={1} style={styles.fileName}>{item.filename}</Text><Text style={styles.fileMeta}>{Math.ceil(item.fileSize / 1024)} KiB</Text></View>}
        <Pressable testID={`composer-remove-attachment-${encodeURIComponent(item.filename)}`} accessibilityRole="button"
          accessibilityLabel={t("task.remove_attachment", { p0: item.filename })} disabled={disabled}
          onPress={() => onRemove(item.id)} style={item.previewUri ? styles.removeImage : styles.removeFile}><X size={16} color={colors.textMuted} /></Pressable>
      </View>)}
    </ScrollView>
    <Modal visible={Boolean(selected)} transparent onRequestClose={close}>
      <View testID="draft-attachment-lightbox" ref={modalRef} role="dialog" accessibilityViewIsModal style={taskStyles.attachmentLightbox}>
        {selected?.previewUri ? <Image testID="draft-attachment-lightbox-image" source={{ uri: selected.previewUri }} resizeMode="contain" style={taskStyles.attachmentLightboxImage} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={t("task.close_attachment_preview")} onPress={close} style={taskStyles.lightboxButton}><X size={20} color={colors.textMuted} /></Pressable>
      </View>
    </Modal>
  </>;
}

export function DraftAttachmentSelectionSheet({ model, bottomInset, onQuickPhrases }: {
  model: import("./useNewTaskDraftAttachments").NewTaskDraftAttachments;
  bottomInset: number;
  onQuickPhrases?(): void;
}) {
  const { styles, colors } = useTaskAppearance();
  const ref = useModalFocusTrap(model.sheetOpen, model.close);
  return <Modal testID="draft-attachment-sheet" visible={model.sheetOpen} transparent animationType="slide" onRequestClose={model.close}>
    <Pressable style={styles.sheetOverlay} accessibilityLabel={t("task.close")} onPress={model.close} />
    <View ref={ref} role="dialog" accessibilityViewIsModal style={[styles.attachmentSheet, { paddingBottom: Math.max(bottomInset, spacing.lg) }]}>
      <View style={styles.attachmentSheetHeader}><Text style={styles.attachmentSheetTitle}>{t("task.add_attachment")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("task.close")} onPress={model.close} style={styles.modalClose}><X size={20} color={colors.textMuted} /></Pressable></View>
      {([ ["file", "task.choose_file"], ["image", "task.photo_library"], ["camera", "task.take_photo"] ] as const).map(([kind, label]) =>
        <Pressable key={kind} testID={`draft-attachment-${kind}`} accessibilityRole="button" disabled={model.busy || model.locked}
          onPress={() => void model.select(kind)} style={styles.attachmentAction}><Paperclip size={20} color={colors.textMuted} /><Text style={styles.attachmentActionTitle}>{t(label)}</Text></Pressable>)}
      {onQuickPhrases ? <Pressable testID="draft-attachment-quick-phrases" accessibilityRole="button"
        disabled={model.busy || model.locked} onPress={onQuickPhrases} style={styles.attachmentAction}>
        <Sparkles size={20} color={colors.textMuted} /><Text style={styles.attachmentActionTitle}>{t("settings_personalization.open_quick_phrases")}</Text>
      </Pressable> : null}
      {model.busy ? <ActivityIndicator color={colors.textMuted} /> : null}
      {model.error ? <Text testID="draft-attachment-error" accessibilityRole="alert" style={styles.attachmentSheetError}>{model.error}</Text> : null}
    </View>
  </Modal>;
}
