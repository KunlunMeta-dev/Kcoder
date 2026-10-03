import { modelOptionSelector } from "@/runtime/task-runtime";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { colors, spacing } from "@/theme";
import { Camera, FileUp, Image as ImageIcon, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { styles } from "./taskStyles";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskInteractions({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
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
        accessibilityLabel="添加附件"
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
            <Text style={styles.attachmentSheetTitle}>添加附件</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
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
              <Text style={styles.attachmentActionTitle}>拍照</Text>
              <Text style={styles.attachmentActionBody}>
                使用相机拍摄并附加当前画面
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
              <Text style={styles.attachmentActionTitle}>照片图库</Text>
              <Text style={styles.attachmentActionBody}>
                选择图片并发送给支持视觉的模型
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
              <Text style={styles.attachmentActionTitle}>选择文件</Text>
              <Text style={styles.attachmentActionBody}>
                从设备文件系统添加附件
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
                正在处理附件，请稍候…
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
        accessibilityLabel="切换模型"
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
              <Text style={styles.attachmentSheetTitle}>模型与推理强度</Text>
              <Text style={styles.modelPickerSubtitle}>
                只影响此任务之后发送的回合
              </Text>
            </View>
            <Pressable
              accessibilityLabel="关闭"
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
                正在读取服务器模型…
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
                      {item.supportsVision ? " · 支持图片" : ""}
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
                服务器没有返回可切换的模型。
              </Text>
            ) : null}
          </ScrollView>
          {(selectedModelOption?.supportedReasoningEfforts?.length ?? 0) > 0 ? (
            <View>
              <Text style={styles.modelPickerSection}>推理强度</Text>
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
