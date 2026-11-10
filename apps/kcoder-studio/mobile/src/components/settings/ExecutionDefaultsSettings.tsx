import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SettingsChoiceSheet, type SettingsChoiceOption } from "@/components/settings/settings-choice-sheet";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-layout";
import { MobileRpcError } from "@/gateway/rpc";
import { SettingsTargetChangedError, useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

type PermissionMode = "ask" | "auto" | "accept_edits" | "dont_ask" | "bypass" | "yolo";
type PermissionChoice = PermissionMode | "follow";

interface ExecutionDefaults {
  persistedPermissionMode: PermissionMode | null;
  effectivePermissionMode: PermissionMode;
  cliPermissionModeOverride: PermissionMode | null;
}

const permissionModes = ["ask", "auto", "accept_edits", "dont_ask", "bypass", "yolo"] as const satisfies readonly PermissionMode[];
const choices = ["follow", ...permissionModes] as const satisfies readonly PermissionChoice[];

function isPermissionMode(value: unknown): value is PermissionMode {
  return permissionModes.some((mode) => mode === value);
}

function parseExecutionDefaults(value: unknown): ExecutionDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("execution_defaults.invalid_response"));
  }
  const result = value as Record<string, unknown>;
  if (
    !(result.persistedPermissionMode === null || isPermissionMode(result.persistedPermissionMode)) ||
    !isPermissionMode(result.effectivePermissionMode) ||
    !(result.cliPermissionModeOverride === null || isPermissionMode(result.cliPermissionModeOverride))
  ) {
    throw new Error(t("execution_defaults.invalid_response"));
  }
  return {
    persistedPermissionMode: result.persistedPermissionMode,
    effectivePermissionMode: result.effectivePermissionMode,
    cliPermissionModeOverride: result.cliPermissionModeOverride,
  };
}

function hasUnknownDelivery(error: unknown): boolean {
  if (error instanceof SettingsTargetChangedError) return error.delivery === "unknown";
  if (error instanceof MobileRpcError) return error.delivery === "unknown" && error.reason !== "remote";
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modeLabel(mode: PermissionMode | null): string {
  return mode ? t(`task.permission_mode_${mode}`) : t("execution_defaults.following");
}

interface PendingPermissionWrite {
  operationId: number;
  inFlight: boolean;
  choice: PermissionChoice;
  draftRevision: number;
}

interface PermissionDraft {
  data: ExecutionDefaults | null;
  choice: PermissionChoice;
  draftRevision: number;
  pendingWrite: PendingPermissionWrite | null;
  outcomeUnknown: boolean;
  reconciledMismatch: boolean;
  error: string | null;
  saved: boolean;
}

const DRAFT_KEY = "execution-defaults";
let nextWriteOperationId = 0;

function emptyDraft(): PermissionDraft {
  return { data: null, choice: "follow", draftRevision: 0, pendingWrite: null,
    outcomeUnknown: false, reconciledMismatch: false, error: null, saved: false };
}

export function ExecutionDefaultsSettings() {
  useLocale();
  const target = useSettingsTarget();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState<PermissionDraft>(() => {
    const stored = target.targetIdentity
      ? target.readDraft<PermissionDraft>(target.targetIdentity, DRAFT_KEY)
      : null;
    return stored ? { ...stored, saved: false,
      outcomeUnknown: Boolean(stored.pendingWrite && !stored.pendingWrite.inFlight) } : emptyDraft();
  });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(draft.pendingWrite?.inFlight ?? false);
  const [baselineVerified, setBaselineVerified] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestGeneration = useRef(0);
  const savingRef = useRef(draft.pendingWrite?.inFlight ?? false);
  const draftRef = useRef(draft);
  const targetIdentityRef = useRef(target.targetIdentity);
  targetIdentityRef.current = target.targetIdentity;

  const commitDraft = (next: PermissionDraft) => {
    draftRef.current = next;
    setDraft(next);
    if (targetIdentityRef.current) target.writeDraft(targetIdentityRef.current, DRAFT_KEY, next);
  };
  const updateDraftState = (changes: Partial<PermissionDraft>) => {
    commitDraft({ ...draftRef.current, ...changes });
  };

  useEffect(() => target.subscribeDraft(() => {
    const identity = target.targetIdentity;
    if (!identity || targetIdentityRef.current !== identity) return;
    const stored = target.readDraft<PermissionDraft>(identity, DRAFT_KEY);
    if (!stored || stored === draftRef.current) return;
    draftRef.current = stored;
    setDraft(stored);
    savingRef.current = stored.pendingWrite?.inFlight ?? false;
    setSaving(savingRef.current);
    setRevision((current) => current + 1);
  }), [target.targetIdentity, target.readDraft, target.subscribeDraft]);

  const recordLateResult = (identity: string, operationId: number, rawResult: unknown) => {
    const current = target.readDraft<PermissionDraft>(identity, DRAFT_KEY);
    if (!current || current.pendingWrite?.operationId !== operationId) return;
    let result: ExecutionDefaults;
    try {
      result = parseExecutionDefaults(rawResult);
    } catch {
      target.writeDraft(identity, DRAFT_KEY, { ...current,
        pendingWrite: { ...current.pendingWrite, inFlight: false }, outcomeUnknown: true,
        error: t("execution_defaults.outcome_unknown") });
      return;
    }
    const pending = current.pendingWrite;
    const persistedChoice = result.persistedPermissionMode ?? "follow";
    const matchesWrite = persistedChoice === pending.choice;
    const sameDraft = current.draftRevision === pending.draftRevision && current.choice === pending.choice;
    target.writeDraft(identity, DRAFT_KEY, { ...current, data: result,
      choice: matchesWrite && sameDraft ? persistedChoice : current.choice,
      pendingWrite: null, outcomeUnknown: false, reconciledMismatch: !matchesWrite,
      error: matchesWrite ? null : t("execution_defaults.receipt_mismatch"), saved: matchesWrite && sameDraft });
  };

  const recordLateFailure = (identity: string, operationId: number, value: unknown) => {
    const current = target.readDraft<PermissionDraft>(identity, DRAFT_KEY);
    if (!current || current.pendingWrite?.operationId !== operationId) return;
    const unknown = hasUnknownDelivery(value);
    target.writeDraft(identity, DRAFT_KEY, { ...current,
      pendingWrite: unknown ? { ...current.pendingWrite, inFlight: false } : null,
      outcomeUnknown: unknown, error: unknown ? t("execution_defaults.outcome_unknown") : errorMessage(value) });
  };

  const supportsExecutionDefaults = target.capabilities.appServer?.experimental?.executionDefaultsV1 === true;

  useEffect(() => {
    const identity = target.targetIdentity;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && targetIdentityRef.current === identity;
    if (!identity || !target.ready || !supportsExecutionDefaults) {
      setLoading(false);
      setBaselineVerified(false);
      setOpen(false);
      if (!identity) commitDraft(emptyDraft());
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
    void target.request<unknown>("settings/execution-defaults/read", {}).then(
      (rawResult) => {
        if (!isCurrent()) return;
        let result: ExecutionDefaults;
        try { result = parseExecutionDefaults(rawResult); }
        catch (value) { updateDraftState({ error: errorMessage(value) }); return; }
        setBaselineVerified(true);
        const current = draftRef.current;
        const pending = current.pendingWrite;
        const persistedChoice = result.persistedPermissionMode ?? "follow";
        if (pending) {
          const matchesWrite = persistedChoice === pending.choice;
          const sameDraft = current.draftRevision === pending.draftRevision && current.choice === pending.choice;
          commitDraft({ ...current, data: result,
            choice: matchesWrite && sameDraft ? persistedChoice : current.choice,
            pendingWrite: null, outcomeUnknown: false, reconciledMismatch: !matchesWrite && persistedChoice !== current.choice,
            error: null, saved: matchesWrite && sameDraft });
        } else {
          const dirty = current.draftRevision > 0 && (current.data === null ||
            current.choice !== (current.data.persistedPermissionMode ?? "follow"));
          commitDraft({ ...current, data: result, choice: dirty ? current.choice : persistedChoice,
            outcomeUnknown: false, error: null, saved: false });
        }
      },
      (value: unknown) => {
        if (isCurrent()) { setBaselineVerified(false); updateDraftState({ error: errorMessage(value) }); }
      },
    ).finally(() => { if (isCurrent()) setLoading(false); });
    return () => { requestGeneration.current += 1; };
  }, [revision, supportsExecutionDefaults, target.ready, target.request, target.targetIdentity]);

  const save = async () => {
    const identity = target.targetIdentity;
    const current = draftRef.current;
    if (!identity || !target.ready || !supportsExecutionDefaults || savingRef.current || loading ||
      !current.data || !baselineVerified || current.outcomeUnknown) return;
    const submittedChoice = current.choice;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && targetIdentityRef.current === identity;
    savingRef.current = true;
    const operationId = ++nextWriteOperationId;
    updateDraftState({ pendingWrite: { inFlight: true, operationId, choice: submittedChoice,
      draftRevision: current.draftRevision }, outcomeUnknown: false, error: null, saved: false, reconciledMismatch: false });
    setSaving(true);
    try {
      const rawResult = await target.request<unknown>("settings/execution-defaults/save", {
        permissionMode: submittedChoice === "follow" ? null : submittedChoice,
      });
      if (!isCurrent()) { recordLateResult(identity, operationId, rawResult); return; }
      let result: ExecutionDefaults;
      try { result = parseExecutionDefaults(rawResult); }
      catch {
        updateDraftState({ pendingWrite: { ...draftRef.current.pendingWrite!, inFlight: false },
          outcomeUnknown: true, error: t("execution_defaults.outcome_unknown") });
        setRevision((value) => value + 1);
        return;
      }
      const latest = draftRef.current;
      const persistedChoice = result.persistedPermissionMode ?? "follow";
      const matchesWrite = persistedChoice === submittedChoice;
      const sameDraft = latest.draftRevision === current.draftRevision && latest.choice === submittedChoice;
      setBaselineVerified(true);
      commitDraft({ ...latest, data: result, choice: matchesWrite && sameDraft ? persistedChoice : latest.choice,
        pendingWrite: null, outcomeUnknown: false, reconciledMismatch: !matchesWrite,
        error: matchesWrite ? null : t("execution_defaults.receipt_mismatch"), saved: matchesWrite && sameDraft });
    } catch (value) {
      if (!isCurrent()) recordLateFailure(identity, operationId, value);
      else if (hasUnknownDelivery(value)) {
        updateDraftState({ pendingWrite: { ...draftRef.current.pendingWrite!, inFlight: false },
          outcomeUnknown: true, error: t("execution_defaults.outcome_unknown") });
        setRevision((value) => value + 1);
      } else updateDraftState({ pendingWrite: null, outcomeUnknown: false, error: errorMessage(value) });
    } finally {
      if (isCurrent()) { savingRef.current = false; setSaving(false); }
    }
  };

  const { data, choice, outcomeUnknown, reconciledMismatch, error, saved } = draft;
  const currentChoice = data?.persistedPermissionMode ?? "follow";
  const dirty = data !== null && currentChoice !== choice;
  const canSave = dirty && baselineVerified && !loading && !saving && !outcomeUnknown;
  const options: readonly SettingsChoiceOption<PermissionChoice>[] = choices.map((value) => ({
    value,
    label: value === "follow" ? t("execution_defaults.follow_target") : modeLabel(value),
    testID: `execution-defaults-option-${value}`,
  }));

  return (
    <SettingsGroup title={t("execution_defaults.title")} testID="execution-defaults-settings">
      <Text style={styles.description}>{t("execution_defaults.description")}</Text>
      {!target.server ? (
        <Text testID="execution-defaults-target-required" style={styles.note}>
          {target.loading ? t("execution_defaults.loading") : t("execution_defaults.target_required")}
        </Text>
      ) : null}
      {target.server && !target.ready && !target.error ? (
        <StatusLine loading label={t("execution_defaults.loading")} styles={styles} colors={colors} />
      ) : null}
      {target.error ? <Text testID="execution-defaults-error" accessibilityRole="alert" style={styles.error}>{target.error}</Text> : null}
      {target.ready && !supportsExecutionDefaults ? (
        <Text testID="execution-defaults-unsupported" accessibilityRole="alert" style={styles.error}>
          {t("execution_defaults.unsupported")}
        </Text>
      ) : null}
          {target.ready && supportsExecutionDefaults && loading && !data ? (
        <StatusLine loading label={t("execution_defaults.loading")} styles={styles} colors={colors} />
      ) : null}
      {target.ready && supportsExecutionDefaults && !loading && !baselineVerified && error ? (
        <RetryNotice message={outcomeUnknown ? t("execution_defaults.outcome_unknown") : error} onRetry={() => setRevision((value) => value + 1)} label={t(outcomeUnknown ? "execution_defaults.check_current" : "execution_defaults.retry")} styles={styles} colors={colors} />
      ) : null}
      {data ? (
        <>
          <SettingsRow
            testID="execution-defaults-permission-mode"
            label={t("execution_defaults.mode_label")}
            note={t("execution_defaults.mode_note")}
            value={choice === "follow" ? t("execution_defaults.follow_target") : modeLabel(choice)}
            onPress={() => { if (target.ready && baselineVerified && !loading && !saving && !outcomeUnknown) setOpen(true); }}
            last
          />
          <View style={styles.detailBlock}>
            <Text testID="execution-defaults-effective" style={styles.detailText}>
              {t("execution_defaults.effective")}: {modeLabel(data.effectivePermissionMode)}
            </Text>
            <Text testID="execution-defaults-persisted" style={styles.note}>
              {t("execution_defaults.saved")}: {modeLabel(data.persistedPermissionMode)}
            </Text>
            {data.cliPermissionModeOverride ? (
              <Text testID="execution-defaults-cli-override" style={styles.warning}>
                {t("execution_defaults.cli_override", { p0: modeLabel(data.cliPermissionModeOverride) })}
              </Text>
            ) : null}
          </View>
          {outcomeUnknown ? <Text testID="execution-defaults-outcome-unknown" accessibilityRole="alert" style={styles.error}>{t("execution_defaults.outcome_unknown")}</Text> : null}
          {reconciledMismatch ? <Text testID="execution-defaults-reconciled" accessibilityRole="alert" style={styles.warning}>{t("execution_defaults.reconciled_not_saved")}</Text> : null}
          {error && baselineVerified && !outcomeUnknown ? <Text testID="execution-defaults-error" accessibilityRole="alert" selectable style={styles.error}>{error}</Text> : null}
          {saved ? <Text testID="execution-defaults-saved" accessibilityLiveRegion="polite" style={styles.success}>{t("execution_defaults.saved_status")}</Text> : null}
          <Pressable
            testID="execution-defaults-save"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={() => void save()}
            style={({ pressed }) => [styles.saveButton, (!canSave || saving) && styles.disabled, pressed && styles.pressed]}
          >
            {saving ? <ActivityIndicator size="small" color={colors.accentText} /> : null}
            <Text style={styles.saveText}>{t(saving ? "execution_defaults.saving" : "execution_defaults.save")}</Text>
          </Pressable>
        </>
      ) : null}
      <SettingsChoiceSheet
        visible={open && Boolean(data) && baselineVerified && target.ready && supportsExecutionDefaults && !loading && !saving && !outcomeUnknown}
        testID="execution-defaults-choice-sheet"
        title={t("execution_defaults.mode_label")}
        options={options}
        selected={choice}
        onSelect={(value) => { if (!savingRef.current && !loading && baselineVerified && !outcomeUnknown) { updateDraftState({ choice: value, draftRevision: draftRef.current.draftRevision + 1, saved: false, error: null, reconciledMismatch: false }); } }}
        onClose={() => setOpen(false)}
      />
    </SettingsGroup>
  );
}

function StatusLine({ label, loading, styles, colors }: { label: string; loading: boolean; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View testID="execution-defaults-loading" accessibilityState={{ busy: loading }} style={styles.statusRow}>
      {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <Text style={styles.note}>{label}</Text>
    </View>
  );
}

function RetryNotice({ message, onRetry, label, styles, colors }: { message: string; onRetry(): void; label: string; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View style={styles.retryBlock}>
      <Text testID="execution-defaults-error" accessibilityRole="alert" selectable style={styles.error}>{message}</Text>
      <Pressable testID="execution-defaults-retry" accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
        <Text style={styles.retryText}>{label}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  description: { color: colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  note: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  detailBlock: { gap: spacing.xs, paddingVertical: spacing.sm },
  detailText: { color: colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: spacing.lg },
  warning: { color: colors.yellow, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  statusRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  success: { color: colors.green, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  retryBlock: { gap: spacing.xs, paddingBottom: spacing.sm },
  retryButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: spacing.lg },
  retryText: { color: colors.text, fontSize: 14 },
  saveButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.blue },
  saveText: { color: colors.accentText, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});

export default ExecutionDefaultsSettings;
