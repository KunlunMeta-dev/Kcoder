import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { spacing } from "@/theme";
import { Camera, FileUp, Image as ImageIcon, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";
import { useTaskAppearance } from "./taskStyles";
import { TaskModelPicker } from "./TaskModelPicker";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskInteractions({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const {
    bottomInset,
    attachmentSheet,
    attachmentLoading,
    attachmentError,
    modelPickerOpen,
    closeAttachmentSheet,
    attachmentSheetRef,
    pickFile,
    pickImage,
    takePhoto,
  } = model;
  return (
    <>
      <Modal
        visible={attachmentSheet}
        transparent
        animationType="slide"
        accessibilityLabel={t("task.add_attachment")}
        onRequestClose={closeAttachmentSheet}
      >
        <Pressable style={styles.sheetOverlay} onPress={closeAttachmentSheet} />
        <View
          ref={attachmentSheetRef}
          style={[
            styles.attachmentSheet,
            { paddingBottom: Math.max(bottomInset, spacing.lg) },
          ]}
        >
          <View style={styles.attachmentSheetHeader}>
            <Text style={styles.attachmentSheetTitle}>
              {t("task.add_attachment")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("task.close")}
              disabled={attachmentLoading}
              accessibilityState={{
                disabled: attachmentLoading,
                busy: attachmentLoading,
              }}
              onPress={closeAttachmentSheet}
              style={[
                styles.modalClose,
                attachmentLoading && styles.sendDisabled,
              ]}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void takePhoto()}
            style={styles.attachmentAction}
          >
            <Camera size={21} color={colors.green} />
            <View>
              <Text style={styles.attachmentActionTitle}>
                {t("task.take_photo")}
              </Text>
              <Text style={styles.attachmentActionBody}>
                {t("task.take_a_photo_and_attach_it")}
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void pickImage()}
            style={styles.attachmentAction}
          >
            <ImageIcon size={21} color={colors.green} />
            <View>
              <Text style={styles.attachmentActionTitle}>
                {t("task.photo_library")}
              </Text>
              <Text style={styles.attachmentActionBody}>
                {t("task.choose_images_for_a_model_that_supports_vision")}
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={attachmentLoading}
            accessibilityState={{
              disabled: attachmentLoading,
              busy: attachmentLoading,
            }}
            onPress={() => void pickFile()}
            style={styles.attachmentAction}
          >
            <FileUp size={21} color={colors.blue} />
            <View>
              <Text style={styles.attachmentActionTitle}>
                {t("task.choose_file")}
              </Text>
              <Text style={styles.attachmentActionBody}>
                {t("task.attach_files_from_your_device")}
              </Text>
            </View>
          </Pressable>
          {attachmentLoading ? (
            <View
              accessibilityRole="progressbar"
              style={styles.attachmentProgress}
            >
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={styles.attachmentActionBody}>
                {t("task.preparing_attachments")}
              </Text>
            </View>
          ) : null}
          {attachmentError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentSheetError}
            >
              {attachmentError}
            </Text>
          ) : null}
        </View>
      </Modal>
      {modelPickerOpen ? <TaskModelPicker model={model} /> : null}
    </>
  );
}
