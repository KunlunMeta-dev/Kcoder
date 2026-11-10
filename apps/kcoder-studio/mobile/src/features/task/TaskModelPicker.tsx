import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View, type ScrollViewInstance } from "react-native";
import { ChevronLeft, ChevronRight, X } from "lucide-react-native";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { modelOptionSelector, type ModelOption } from "@/runtime/task-runtime";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { spacing } from "@/theme";
import { useTaskAppearance } from "./taskStyles";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

/** One modal owns list/detail navigation and focus; preferences keep their existing authority. */
export function TaskModelPicker({ model }: { model: ReturnType<typeof useTaskModelPreferences> }) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const { bottomInset, snapshot, modelOptions, modelsLoading, modelBusy, modelError,
    closeModelPicker, applyTurnPreferences, selectedModelOption } = model;
  const [detailId, setDetailId] = useState<string | null>(null);
  const lastDetailId = useRef<string | null>(null);
  const listOffset = useRef(0);
  const listRef = useRef<ScrollViewInstance>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const detail = modelOptions.find(item => item.id === detailId);
  const effort = snapshot.pendingTurnPreferences
    ? snapshot.pendingTurnPreferences.reasoningEffort : snapshot.reasoningEffort;
  const close = () => { if (!modelBusy) closeModelPicker(); };
  const back = () => { if (!modelBusy) detail ? setDetailId(null) : close(); };
  const focusSelector = detail ? '[data-testid="conversation-model-back"]'
    : lastDetailId.current ? `[data-testid=${JSON.stringify(`conversation-model-${lastDetailId.current}`)}]` : undefined;
  const sheetRef = useModalFocusTrap(true, back, focusSelector, true);
  const select = async (item: ModelOption, dismiss = false) => {
    if (modelBusy) return;
    const saved = selectedModelOption?.id === item.id || await applyTurnPreferences(modelOptionSelector(item),
      item.supportedReasoningEfforts?.includes(effort ?? "") ? effort : item.defaultReasoningEffort);
    if (saved && dismiss && mounted.current) closeModelPicker();
  };
  const openDetails = (item: ModelOption) => {
    if (modelBusy) return;
    lastDetailId.current = item.id;
    setDetailId(item.id);
    void select(item);
  };

  return <Modal visible transparent animationType={Platform.OS === "web" ? "none" : "slide"}
    accessibilityLabel={t(detail ? "task.model_details" : "task.change_model")} onRequestClose={back}>
    <Pressable accessibilityLabel={t("task.close")} style={styles.sheetOverlay} onPress={close} />
    <View ref={sheetRef} testID="conversation-model-sheet" role="dialog" accessibilityViewIsModal
      style={[styles.modelPickerSheet, { paddingBottom: Math.max(bottomInset, spacing.lg) }]}>
      <View style={styles.attachmentSheetHeader}>
        {detail ? <Pressable testID="conversation-model-back" accessibilityRole="button"
          accessibilityLabel={t("task.back_to_models")} disabled={modelBusy} onPress={back} style={styles.modalClose}>
          <ChevronLeft size={20} color={colors.textMuted} />
        </Pressable> : null}
        <View style={styles.modelPickerCopy}>
          <Text accessibilityRole="header" style={styles.attachmentSheetTitle}>
            {t(detail ? "task.model_details" : "task.change_model")}
          </Text>
          <Text style={styles.modelPickerSubtitle}>{t("task.applies_to_future_turns_in_this_task")}</Text>
        </View>
        <Pressable testID="conversation-model-close" accessibilityRole="button" accessibilityLabel={t("task.close")}
          disabled={modelBusy} onPress={close} style={styles.modalClose}><X size={20} color={colors.textMuted} /></Pressable>
      </View>
      {modelsLoading ? <View style={styles.modelPickerLoading}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={styles.modelPickerSubtitle}>{t("task.loading_server_models")}</Text>
      </View> : null}
      {modelError ? <Text accessibilityRole="alert" style={styles.attachmentError}>{modelError}</Text> : null}
      {detail ? <ScrollView testID="conversation-model-details" style={styles.modelPickerList} contentContainerStyle={styles.modelPickerContent}>
        <View style={styles.modelPickerDetailHeading}>
          <Text testID="conversation-model-detail-name" style={styles.modelPickerName}>{detail.displayName}</Text>
          <Text style={styles.modelPickerProvider}>{detail.providerName}{detail.supportsVision ? t("task.supports_images") : ""}</Text>
        </View>
        {selectedModelOption?.id === detail.id ? (detail.supportedReasoningEfforts?.length ? <View>
          <Text style={styles.modelPickerSection}>{t("task.reasoning_effort")}</Text>
          <View testID="conversation-model-efforts" accessibilityRole="radiogroup" accessibilityLabel={t("task.reasoning_effort")} style={styles.modelEffortList}>
            {detail.supportedReasoningEfforts.map(value => {
              const checked = (effort ?? detail.defaultReasoningEffort) === value;
              return <Pressable key={value} testID={`conversation-model-effort-${value}`} accessibilityRole="radio"
                aria-checked={checked} accessibilityState={{ checked, disabled: modelBusy }} disabled={modelBusy}
                onPress={() => void applyTurnPreferences(modelOptionSelector(detail), value)}
                style={[styles.modelEffort, checked && styles.modelEffortSelected]}>
                <Text style={[styles.modelEffortText, checked && styles.modelEffortTextSelected]}>{reasoningEffortLabel(value)}</Text>
              </Pressable>;
            })}
          </View>
        </View> : <Text testID="conversation-model-no-efforts" style={styles.modelPickerSubtitle}>{t("task.no_selectable_reasoning_effort")}</Text>)
          : !modelBusy ? <Button testID="conversation-model-retry" onPress={() => select(detail)}>{t("task.retry_model_selection")}</Button> : null}
      </ScrollView> : <ScrollView ref={listRef} testID="conversation-model-list" style={styles.modelPickerList}
        contentContainerStyle={styles.modelPickerContent} scrollEventThrottle={16}
        onScroll={event => { listOffset.current = event.nativeEvent.contentOffset.y; }}
        onContentSizeChange={() => listRef.current?.scrollTo({ y: listOffset.current, animated: false })}>
        {modelOptions.map(item => {
          const checked = selectedModelOption?.id === item.id;
          return <View key={item.id} style={[styles.modelPickerOption, checked && styles.modelPickerSelected]}>
            <Pressable testID={`conversation-model-${item.id}`} accessibilityRole="radio"
              aria-checked={checked} accessibilityState={{ checked, disabled: modelBusy }} disabled={modelBusy}
              onPress={() => void select(item, true)} style={styles.modelPickerSelect}>
              <Text style={styles.modelPickerName}>{item.displayName}</Text>
              <Text style={styles.modelPickerProvider}>{item.providerName}{item.supportsVision ? t("task.supports_images") : ""}</Text>
            </Pressable>
            <Pressable testID={`conversation-model-details-${item.id}`} accessibilityRole="button"
              accessibilityLabel={`${t("task.model_details")} · ${item.displayName}`}
              accessibilityState={{ disabled: modelBusy }} disabled={modelBusy}
              onPress={() => openDetails(item)} style={styles.modelPickerDetailsButton}>
              <ChevronRight size={18} color={colors.textDim} />
            </Pressable>
          </View>;
        })}
        {!modelsLoading && !modelOptions.length ? <Text style={styles.modelPickerEmpty}>{t("task.the_server_returned_no_selectable_models")}</Text> : null}
      </ScrollView>}
    </View>
  </Modal>;
}
