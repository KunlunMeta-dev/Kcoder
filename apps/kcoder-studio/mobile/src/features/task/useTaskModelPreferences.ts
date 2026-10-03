import { selectedModelOption as findSelectedModelOption } from "@/runtime/task-runtime";

import type { useTaskAttachments } from "./useTaskAttachments";

export function useTaskModelPreferences(
  context: ReturnType<typeof useTaskAttachments>,
) {
  const {
    openModelPicker,
    task,
    profile,
    server,
    demo,
    onTurnPreferencesChange,
    snapshot,
    setModelPickerOpen,
    modelOptions,
    setModelOptions,
    modelsLoading,
    setModelsLoading,
    modelBusy,
    setModelBusy,
    setModelError,
  } = context;

  const applyTurnPreferences = async (
    model: string,
    reasoningEffort?: string,
  ) => {
    if (modelBusy) return;
    setModelBusy(true);
    setModelError(null);
    try {
      await task.setTurnPreferences(model, reasoningEffort);
      onTurnPreferencesChange?.(model, reasoningEffort);
    } catch (value) {
      setModelError(value instanceof Error ? value.message : String(value));
    } finally {
      setModelBusy(false);
    }
  };

  const selectedModelOption = findSelectedModelOption(
    modelOptions,
    snapshot.model,
  );
  return {
    ...context,
    openModelPicker,
    applyTurnPreferences,
    selectedModelOption,
  };
}
