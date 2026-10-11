import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { modelOptionSelector } from "@/runtime/task-runtime";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { spacing } from "@/theme";
import { Camera, FileUp, Image as ImageIcon, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useTaskAppearance } from "./taskStyles";
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
    snapshot,
    attachmentSheet,
    attachmentLoading,
    attachmentError,
    modelPickerOpen,
    modelOptions,
    modelsLoading,
    modelBusy,
    modelError,
    closeAttachmentSheet,
    attachmentSheetRef,
    closeModelPicker,
    modelPickerRef,
    pickFile,
    pickImage,
    takePhoto,
    applyTurnPreferences,
    selectedModelOption,
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
      <Modal
        visible={modelPickerOpen}
        transparent
        animationType="slide"
        accessibilityLabel={t("task.change_model")}
        onRequestClose={closeModelPicker}
      >
        <Pressable style={styles.sheetOverlay} onPress={closeModelPicker} />
        <View
          ref={modelPickerRef}
          role="dialog"
          accessibilityViewIsModal
          style={[
            styles.modelPickerSheet,
            { paddingBottom: Math.max(bottomInset, spacing.lg) },
          ]}
        >
          <View style={styles.attachmentSheetHeader}>
            <View>
              <Text style={styles.attachmentSheetTitle}>
                {t("task.model_and_reasoning_effort")}
              </Text>
              <Text style={styles.modelPickerSubtitle}>
                {t("task.applies_to_future_turns_in_this_task")}
              </Text>
            </View>
            <Pressable
              accessibilityLabel={t("task.close")}
              disabled={modelBusy}
              onPress={closeModelPicker}
              style={styles.modalClose}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          {modelsLoading ? (
            <View style={styles.modelPickerLoading}>
              <ActivityIndicator color={colors.textMuted} />
              <Text style={styles.modelPickerSubtitle}>
                {t("task.loading_server_models")}
              </Text>
            </View>
          ) : null}
          {modelError ? (
            <Text accessibilityRole="alert" style={styles.attachmentError}>
              {modelError}
            </Text>
          ) : null}
          <ScrollView
            style={styles.modelPickerList}
            contentContainerStyle={styles.modelPickerContent}
          >
            {modelOptions.map((item) => {
              const checked = selectedModelOption?.id === item.id;
              return (
                <Pressable
                  key={item.id}
                  testID={`conversation-model-${item.id}`}
                  accessibilityRole="radio"
                  aria-checked={checked}
                  accessibilityState={{ checked, disabled: modelBusy }}
                  disabled={modelBusy}
                  onPress={() =>
                    void applyTurnPreferences(
                      modelOptionSelector(item),
                      item.supportedReasoningEfforts?.includes(
                        snapshot.reasoningEffort ?? "",
                      )
                        ? snapshot.reasoningEffort
                        : item.defaultReasoningEffort,
                    )
                  }
                  style={[
                    styles.modelPickerOption,
                    checked && styles.modelPickerSelected,
                  ]}
                >
                  <View style={styles.modelPickerCopy}>
                    <Text style={styles.modelPickerName}>
                      {item.displayName}
                    </Text>
                    <Text style={styles.modelPickerProvider}>
                      {item.providerName}
                      {item.supportsVision ? t("task.supports_images") : ""}
                    </Text>
                  </View>
                  {checked ? (
                    <Text style={styles.modelPickerCheck}>✓</Text>
                  ) : null}
                </Pressable>
              );
            })}
            {!modelsLoading && modelOptions.length === 0 ? (
              <Text style={styles.modelPickerEmpty}>
                {t("task.the_server_returned_no_selectable_models")}
              </Text>
            ) : null}
          </ScrollView>
          {(selectedModelOption?.supportedReasoningEfforts?.length ?? 0) > 0 ? (
            <View>
              <Text style={styles.modelPickerSection}>
                {t("task.reasoning_effort")}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.modelEffortList}
              >
                {selectedModelOption?.supportedReasoningEfforts?.map(
                  (effort) => {
                    const checked = snapshot.reasoningEffort === effort;
                    return (
                      <Pressable
                        key={effort}
                        accessibilityRole="radio"
                        aria-checked={checked}
                        accessibilityState={{ checked, disabled: modelBusy }}
                        disabled={modelBusy}
                        onPress={() =>
                          void applyTurnPreferences(
                            modelOptionSelector(selectedModelOption),
                            effort,
                          )
                        }
                        style={[
                          styles.modelEffort,
                          checked && styles.modelEffortSelected,
                        ]}
                      >
                        <Text
                          style={[
                            styles.modelEffortText,
                            checked && styles.modelEffortTextSelected,
                          ]}
                        >
                          {reasoningEffortLabel(effort)}
                        </Text>
                      </Pressable>
                    );
                  },
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}
