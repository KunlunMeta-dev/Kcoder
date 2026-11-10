import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { SettingsTargetChangedError, useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import { MobileRpcError } from "@/gateway/rpc";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

interface RuntimeContext {
  instructions: string;
}

interface PendingInstructionsWrite {
  inFlight: boolean;
  operationId: number;
  instructions: string;
  draftRevision: number;
}

interface CustomInstructionsDraft {
  instructions: string;
  draftRevision: number;
  savedInstructions: string | null;
  pendingWrite: PendingInstructionsWrite | null;
  outcomeUnknown: boolean;
  reconciledMismatch: boolean;
  error: string | null;
  saved: boolean;
}

const DRAFT_KEY = "custom-instructions";
let nextWriteOperationId = 0;

function emptyDraft(): CustomInstructionsDraft {
  return {
    instructions: "",
    draftRevision: 0,
    savedInstructions: null,
    pendingWrite: null,
    outcomeUnknown: false,
    reconciledMismatch: false,
    error: null,
    saved: false,
  };
}

const MAX_INSTRUCTION_BYTES = 64 * 1024;

function parseRuntimeContext(value: unknown): RuntimeContext {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).instructions !== "string") {
    throw new Error(t("custom_instructions.invalid_response"));
  }
  return { instructions: (value as { instructions: string }).instructions };
}

function hasUnknownDelivery(error: unknown): boolean {
  if (error instanceof SettingsTargetChangedError) return error.delivery === "unknown";
  if (error instanceof MobileRpcError) return error.delivery === "unknown" && error.reason !== "remote";
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CustomInstructionsSettings() {
  useLocale();
  const target = useSettingsTarget();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState<CustomInstructionsDraft>(() => {
    const stored = target.targetIdentity
      ? target.readDraft<CustomInstructionsDraft>(target.targetIdentity, DRAFT_KEY)
      : null;
    return stored
      ? { ...stored, saved: false, outcomeUnknown: Boolean(stored.pendingWrite && !stored.pendingWrite.inFlight) }
      : emptyDraft();
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(draft.pendingWrite?.inFlight ?? false);
  const [baselineVerified, setBaselineVerified] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestGeneration = useRef(0);
  const savingRef = useRef(draft.pendingWrite?.inFlight ?? false);
  const draftRef = useRef(draft);
  const targetIdentityRef = useRef(target.targetIdentity);
  targetIdentityRef.current = target.targetIdentity;

  const commitDraft = (next: CustomInstructionsDraft) => {
    draftRef.current = next;
    setDraft(next);
    const identity = targetIdentityRef.current;
    if (identity) target.writeDraft(identity, DRAFT_KEY, next);
  };
  const updateDraftState = (changes: Partial<CustomInstructionsDraft>) => {
    commitDraft({ ...draftRef.current, ...changes });
  };

  useEffect(() => target.subscribeDraft(() => {
    const identity = target.targetIdentity;
    if (!identity || targetIdentityRef.current !== identity) return;
    const stored = target.readDraft<CustomInstructionsDraft>(identity, DRAFT_KEY);
    if (!stored || stored === draftRef.current) return;
    draftRef.current = stored;
    setDraft(stored);
    savingRef.current = stored.pendingWrite?.inFlight ?? false;
    setSaving(savingRef.current);
    setRevision((current) => current + 1);
  }), [target.targetIdentity, target.readDraft, target.subscribeDraft]);

  const recordLateWriteResult = (identity: string, operationId: number, rawResult: unknown) => {
    const current = target.readDraft<CustomInstructionsDraft>(identity, DRAFT_KEY);
    if (!current || current.pendingWrite?.operationId !== operationId) return;
    let result: RuntimeContext;
    try {
      result = parseRuntimeContext(rawResult);
    } catch {
      target.writeDraft(identity, DRAFT_KEY, {
        ...current,
        pendingWrite: { ...current.pendingWrite, inFlight: false },
        outcomeUnknown: true,
        error: t("custom_instructions.outcome_unknown"),
      });
      return;
    }
    const pending = current.pendingWrite;
    const draftStillSubmitted = current.draftRevision === pending.draftRevision
      && current.instructions === pending.instructions;
    target.writeDraft(identity, DRAFT_KEY, {
      ...current,
      instructions: result.instructions === pending.instructions && draftStillSubmitted
        ? result.instructions
        : current.instructions,
      savedInstructions: result.instructions,
      pendingWrite: null,
      outcomeUnknown: false,
      reconciledMismatch: result.instructions !== pending.instructions,
      error: result.instructions === pending.instructions ? null : t("custom_instructions.receipt_mismatch"),
      saved: result.instructions === pending.instructions && draftStillSubmitted,
    });
  };

  const recordLateWriteFailure = (identity: string, operationId: number, value: unknown) => {
    const current = target.readDraft<CustomInstructionsDraft>(identity, DRAFT_KEY);
    if (!current || current.pendingWrite?.operationId !== operationId) return;
    const unknown = hasUnknownDelivery(value);
    target.writeDraft(identity, DRAFT_KEY, {
      ...current,
      pendingWrite: unknown ? { ...current.pendingWrite, inFlight: false } : null,
      outcomeUnknown: unknown,
      error: unknown ? t("custom_instructions.outcome_unknown") : errorMessage(value),
    });
  };

  useEffect(() => {
    const identity = target.targetIdentity;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && targetIdentityRef.current === identity;
    if (!identity || !target.ready) {
      setLoading(false);
      setBaselineVerified(false);
      if (!identity) {
        commitDraft(emptyDraft());
      }
      savingRef.current = draftRef.current.pendingWrite?.inFlight ?? false;
      setSaving(savingRef.current);
      return () => { requestGeneration.current += 1; };
    }

    if (draftRef.current.pendingWrite?.inFlight) {
      setLoading(false);
      setBaselineVerified(false);
      return () => { requestGeneration.current += 1; };
    }

    updateDraftState({ error: null, saved: false, reconciledMismatch: false });
    setLoading(true);
    setBaselineVerified(false);
    void target.request<unknown>("runtime.context.get", {}).then(
      (rawResult) => {
        if (!isCurrent()) return;
        let result: RuntimeContext;
        try {
          result = parseRuntimeContext(rawResult);
        } catch (value) {
          setBaselineVerified(false);
          updateDraftState({ error: errorMessage(value) });
          return;
        }
        const value = result.instructions;
        setBaselineVerified(true);
        const current = draftRef.current;
        const pending = current.pendingWrite;
        if (pending) {
          const draftStillSubmitted = current.draftRevision === pending.draftRevision
            && current.instructions === pending.instructions;
          if (value === pending.instructions) {
            commitDraft({
              ...current,
              instructions: draftStillSubmitted ? value : current.instructions,
              savedInstructions: value,
              pendingWrite: null,
              outcomeUnknown: false,
              reconciledMismatch: false,
              error: null,
              saved: draftStillSubmitted,
            });
          } else {
            commitDraft({
              ...current,
              savedInstructions: value,
              pendingWrite: null,
              outcomeUnknown: false,
              reconciledMismatch: value !== current.instructions,
              error: null,
              saved: false,
            });
          }
        } else if (!(current.draftRevision > 0 && (
          current.savedInstructions === null || current.instructions !== current.savedInstructions
        ))) {
          commitDraft({
            ...current,
            instructions: value,
            draftRevision: 0,
            savedInstructions: value,
            outcomeUnknown: false,
            reconciledMismatch: false,
            error: null,
            saved: false,
          });
        } else {
          commitDraft({ ...current, savedInstructions: value, error: null, saved: false });
        }
      },
      (value: unknown) => {
        if (isCurrent()) {
          setBaselineVerified(false);
          updateDraftState({ error: errorMessage(value) });
        }
      },
    ).finally(() => {
      if (isCurrent()) setLoading(false);
    });

    return () => { requestGeneration.current += 1; };
  }, [revision, target.ready, target.request, target.targetIdentity]);

  const updateDraft = (value: string) => {
    if (savingRef.current || loading || !target.ready) return;
    updateDraftState({
      instructions: value,
      draftRevision: draftRef.current.draftRevision + 1,
      saved: false,
      error: baselineVerified ? null : draftRef.current.error,
      reconciledMismatch: false,
    });
  };

  const save = async () => {
    const identity = target.targetIdentity;
    const current = draftRef.current;
    const submittedBytes = new TextEncoder().encode(current.instructions).byteLength;
    if (!identity || !target.ready || savingRef.current || loading || !baselineVerified || current.savedInstructions === null || current.outcomeUnknown || current.instructions === current.savedInstructions || submittedBytes > MAX_INSTRUCTION_BYTES) return;
    const submittedInstructions = current.instructions;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && targetIdentityRef.current === identity;
    savingRef.current = true;
    const operationId = ++nextWriteOperationId;
    updateDraftState({
      pendingWrite: { inFlight: true, operationId, instructions: submittedInstructions, draftRevision: current.draftRevision },
      outcomeUnknown: false,
      error: null,
      saved: false,
      reconciledMismatch: false,
    });
    setSaving(true);
    try {
      const rawResult = await target.request<unknown>("runtime.context.update", { instructions: submittedInstructions });
      if (!isCurrent()) {
        recordLateWriteResult(identity, operationId, rawResult);
        return;
      }
      let result: RuntimeContext;
      try {
        result = parseRuntimeContext(rawResult);
      } catch {
        updateDraftState({ pendingWrite: { ...draftRef.current.pendingWrite!, inFlight: false }, outcomeUnknown: true, error: t("custom_instructions.outcome_unknown") });
        setRevision((current) => current + 1);
        return;
      }
      setBaselineVerified(true);
      if (result.instructions === submittedInstructions) {
        const latest = draftRef.current;
        const draftStillSubmitted = latest.draftRevision === current.draftRevision
          && latest.instructions === submittedInstructions;
        commitDraft({
          ...latest,
          instructions: draftStillSubmitted ? result.instructions : latest.instructions,
          savedInstructions: result.instructions,
          pendingWrite: null,
          outcomeUnknown: false,
          reconciledMismatch: false,
          error: null,
          saved: draftStillSubmitted,
        });
      } else {
        updateDraftState({
          savedInstructions: result.instructions,
          pendingWrite: null,
          outcomeUnknown: false,
          reconciledMismatch: true,
          error: t("custom_instructions.receipt_mismatch"),
          saved: false,
        });
      }
    } catch (value) {
      if (!isCurrent()) {
        recordLateWriteFailure(identity, operationId, value);
      } else if (hasUnknownDelivery(value)) {
        updateDraftState({ pendingWrite: { ...draftRef.current.pendingWrite!, inFlight: false }, outcomeUnknown: true, error: t("custom_instructions.outcome_unknown") });
        setRevision((current) => current + 1);
      } else {
        updateDraftState({ pendingWrite: null, outcomeUnknown: false, error: errorMessage(value) });
      }
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const { instructions, savedInstructions, outcomeUnknown, reconciledMismatch, error, saved } = draft;
  const dirty = savedInstructions !== null && instructions !== savedInstructions;
  const instructionBytes = new TextEncoder().encode(instructions).byteLength;
  const instructionsTooLong = instructionBytes > MAX_INSTRUCTION_BYTES;
  const canSave = dirty && baselineVerified && !loading && !saving && !outcomeUnknown && !instructionsTooLong;

  return (
    <SettingsGroup title={t("custom_instructions.title")} testID="custom-instructions-settings">
      <Text style={styles.description}>{t("custom_instructions.description")}</Text>
      {!target.server ? (
        <Text testID="custom-instructions-target-required" style={styles.note}>
          {target.loading ? t("custom_instructions.loading") : t("custom_instructions.target_required")}
        </Text>
      ) : null}
      {target.server && !target.ready && !target.error ? (
        <StatusLine loading label={t("custom_instructions.loading")} styles={styles} colors={colors} />
      ) : null}
      {target.error ? <Text testID="custom-instructions-error" accessibilityRole="alert" style={styles.error}>{target.error}</Text> : null}
      {target.ready && loading ? <StatusLine loading label={t("custom_instructions.loading")} styles={styles} colors={colors} /> : null}
      {outcomeUnknown ? <Text testID="custom-instructions-outcome-unknown" accessibilityRole="alert" style={styles.error}>{t("custom_instructions.outcome_unknown")}</Text> : null}
      {target.ready && !loading && !baselineVerified && error ? (
        <RetryNotice message={outcomeUnknown ? t("custom_instructions.outcome_unknown") : error} onRetry={() => setRevision((value) => value + 1)} label={t(outcomeUnknown ? "custom_instructions.check_current" : "custom_instructions.retry")} styles={styles} />
      ) : null}
      {target.ready ? (
        <>
          <TextInput
            testID="custom-instructions-input"
            accessibilityLabel={t("custom_instructions.title")}
            value={instructions}
            onChangeText={updateDraft}
            placeholder={t("custom_instructions.placeholder")}
            placeholderTextColor={colors.textDim}
            editable={target.ready && !loading && !saving}
            multiline
            textAlignVertical="top"
            style={styles.input}
          />
          <Text style={styles.note}>{t("custom_instructions.note")}</Text>
          {instructionsTooLong ? <Text testID="custom-instructions-too-long" accessibilityRole="alert" style={styles.error}>{t("custom_instructions.too_long")}</Text> : null}
          {reconciledMismatch ? <Text testID="custom-instructions-reconciled" accessibilityRole="alert" style={styles.warning}>{t("custom_instructions.reconciled_not_saved")}</Text> : null}
          {error && baselineVerified && !outcomeUnknown ? <Text testID="custom-instructions-error" accessibilityRole="alert" selectable style={styles.error}>{error}</Text> : null}
          {saved ? <Text testID="custom-instructions-saved" accessibilityLiveRegion="polite" style={styles.success}>{t("custom_instructions.saved")}</Text> : null}
          <Pressable
            testID="custom-instructions-save"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={() => void save()}
            style={({ pressed }) => [styles.saveButton, (!canSave || saving) && styles.disabled, pressed && styles.pressed]}
          >
            {saving ? <ActivityIndicator size="small" color={colors.accentText} /> : null}
            <Text style={styles.saveText}>{t(saving ? "custom_instructions.saving" : "custom_instructions.save")}</Text>
          </Pressable>
        </>
      ) : null}
    </SettingsGroup>
  );
}

function StatusLine({ label, loading, styles, colors }: { label: string; loading: boolean; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View testID="custom-instructions-loading" accessibilityState={{ busy: loading }} style={styles.statusRow}>
      {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <Text style={styles.note}>{label}</Text>
    </View>
  );
}

function RetryNotice({ message, onRetry, label, styles }: { message: string; onRetry(): void; label: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.retryBlock}>
      <Text testID="custom-instructions-error" accessibilityRole="alert" selectable style={styles.error}>{message}</Text>
      <Pressable testID="custom-instructions-retry" accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
        <Text style={styles.retryText}>{label}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  description: { color: colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  input: { minHeight: 180, marginHorizontal: spacing.lg, marginVertical: spacing.md, padding: spacing.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.settingsPageBackground, color: colors.text, fontSize: 14, lineHeight: 20 },
  note: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  statusRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  warning: { color: colors.yellow, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  success: { color: colors.green, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  retryBlock: { gap: spacing.xs, paddingBottom: spacing.sm },
  retryButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: spacing.lg },
  retryText: { color: colors.text, fontSize: 14 },
  saveButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.blue },
  saveText: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});

export default CustomInstructionsSettings;
