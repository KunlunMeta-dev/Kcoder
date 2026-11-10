import { useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ChevronDown, ChevronUp, Pause, Pencil, Play, Target, Trash2, X } from "lucide-react-native";
import { t } from "@/i18n";
import type { TaskRuntime, TaskSnapshot, ThreadGoal } from "@/runtime/task-runtime";
import { captureGoalProjection, goalCanEdit } from "@/runtime/task-runtime/goalProjection";
import { useTheme, useThemedStyles, type ThemeColors, spacing, radius } from "@/theme";
import { Button } from "@/components/ui";
import { MobileRpcError } from "@/gateway/rpc";
import { KeyboardSafeView } from "@/components/keyboard-safe-view";
import { useInterfaceVersion } from "@/storage/interface-version";
import { V3GoalSummary, v3GoalStyles } from "@/features/interface/V3GoalSummary";
import { TodoCard } from "./TaskPlanCard";
import { latestTaskPlan } from "./task-plan";

export { latestTaskPlan } from "./task-plan";

const goalStatusLocaleSuffix: Record<ThreadGoal["status"], string> = {
  active: "active", paused: "paused", blocked: "blocked", complete: "complete", cancelled: "cancelled",
  usageLimited: "usage_limited", budgetLimited: "budget_limited",
};

/** Persistent controls consume the same target Goal methods as slash commands. */
export function TaskGoalControls({ task, snapshot }: { task: TaskRuntime; snapshot: TaskSnapshot }) {
  const v3 = useInterfaceVersion() === "v3";
  const focused = useIsFocused();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const v3Styles = useThemedStyles(v3GoalStyles);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<ThreadGoal | null>(null);
  const editingOwner = useRef<{ task: TaskRuntime; threadId: string } | null>(null);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const goal = snapshot.goal;
  const todos = v3 ? [] : latestTaskPlan(snapshot);
  const owner = useRef(task);
  const unsupportedProbe = useRef<{ task: TaskRuntime; generation: number } | null>(null);
  owner.current = task;
  const refresh = async (explicit = false) => {
    if (!explicit && unsupportedProbe.current?.task === task && unsupportedProbe.current.generation === task.clientGeneration) return;
    const projection = captureGoalProjection(task);
    try { await task.getGoal(explicit); }
    catch (error) {
      if (!explicit && projection.current() && error instanceof MobileRpcError && error.reason === "remote" && error.code === -32601) {
        unsupportedProbe.current = { task, generation: task.clientGeneration };
        return;
      }
      if (projection.current() && task.goalProjectionVersion === projection.version)
        task.patch({ goalError: error instanceof MobileRpcError && error.reason === "remote" && error.code === -32601 ? t("task.goal_unsupported") : error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => {
    if (focused && snapshot.connected) void refresh();
  }, [task, focused, snapshot.connected, task.clientGeneration]);
  useEffect(() => { setEditing(null); setExpanded(false); }, [task]);
  const run = async (operation: () => Promise<unknown>) => {
    if (owner.current !== task || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const projection = captureGoalProjection(task);
    task.patch({ goalError: null });
    try {
      await operation();
      if (projection.current()) setEditing(null);
    } catch (error) {
      if (projection.current()) task.patch({ goalError: task.snapshot.goalMutationUnknown ? t("task.goal_write_unknown") : error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      if (owner.current === task) setBusy(false);
    }
  };
  const editingVisible = Boolean(editing && editingOwner.current?.task === task && editingOwner.current.threadId === snapshot.threadId);
  if (!goal && !todos.length && !snapshot.goalError && !editingVisible) return null;
  const resumable = goal?.status === "paused" || goal?.status === "blocked";
  const disabled = busy || !snapshot.connected || Boolean(snapshot.archivedAt) || Boolean(snapshot.goalMutationUnknown);
  const editIsCurrent = Boolean(editingVisible && editing && !snapshot.goalEditReadRequired && goalCanEdit(goal) && editing.goalId === goal?.goalId && editing.revision === goal?.revision);
  const edit = () => { if (owner.current !== task || !goal) return; editingOwner.current = { task, threadId: snapshot.threadId }; setObjective(goal.objective); setEditing(goal); };
  const label = goal ? `${goal.mode === "strict" ? "Goal Pro" : goal.mode === "arrangement" ? "UltGoal" : "Goal"}${v3 ? " " : " · "}${t(`task.goal_status_${goalStatusLocaleSuffix[goal.status]}`)}` : "";
  const usage = goal ? `${goal.tokensUsed}${goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`} tokens · ${Math.floor(goal.timeUsedSeconds)}s` : "";
  return <View testID="task-goal-controls" style={v3 && goal ? v3Styles.root : styles.root}>
    {goal ? <>
      {v3 ? <V3GoalSummary title={label} usage={usage} expanded={expanded} busy={busy} disabled={disabled}
        editable={goalCanEdit(goal)} active={goal.status === "active"} resumable={resumable}
        onToggle={() => setExpanded(!expanded)} onEdit={edit}
        onPauseResume={() => void run(() => task.updateGoalStatus(resumable ? "active" : "paused", goal))}
        onClear={() => void run(() => task.clearGoal(goal))} /> : <>
      <View style={styles.summary}>
        <Target size={16} color={colors.textMuted} />
        <View style={styles.copy}>
          <Text testID="task-goal-status" style={styles.title}>{goal.mode === "strict" ? "Goal Pro" : goal.mode === "arrangement" ? "UltGoal" : "Goal"} · {t(`task.goal_status_${goalStatusLocaleSuffix[goal.status]}`)}</Text>
          <Text testID="task-goal-objective" numberOfLines={expanded ? undefined : 1} style={styles.objective}>{goal.objective}</Text>
        </View>
        <Pressable testID="task-goal-expand" accessibilityRole="button" accessibilityLabel={t("task.goal_details")} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.action}>
          {expanded ? <ChevronUp size={18} color={colors.textMuted} /> : <ChevronDown size={18} color={colors.textMuted} />}
        </Pressable>
      </View>
      <View style={styles.actions}>
        <Text testID="task-goal-usage" style={[styles.metrics, styles.copy]}>{goal.tokensUsed}{goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget}`} tokens · {Math.floor(goal.timeUsedSeconds)}s</Text>
        {busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        {goalCanEdit(goal) ? <Pressable testID="task-goal-edit" accessibilityRole="button" accessibilityLabel={t("task.goal_edit")} disabled={disabled} onPress={() => { if (owner.current !== task) return; editingOwner.current = { task, threadId: snapshot.threadId }; setObjective(goal.objective); setEditing(goal); }} style={[styles.action, disabled && styles.disabled]}><Pencil size={17} color={colors.textMuted} /></Pressable> : null}
        {goal.status === "active" || resumable ? <Pressable testID={resumable ? "task-goal-resume" : "task-goal-pause"} accessibilityRole="button" accessibilityLabel={t(resumable ? "task.goal_resume" : "task.goal_pause")} disabled={disabled} onPress={() => void run(() => task.updateGoalStatus(resumable ? "active" : "paused", goal))} style={[styles.action, disabled && styles.disabled]}>{resumable ? <Play size={17} color={colors.textMuted} /> : <Pause size={17} color={colors.textMuted} />}</Pressable> : null}
        <Pressable testID="task-goal-clear" accessibilityRole="button" accessibilityLabel={t("task.goal_clear")} disabled={disabled} onPress={() => void run(() => task.clearGoal(goal))} style={[styles.action, disabled && styles.disabled]}><Trash2 size={17} color={colors.textMuted} /></Pressable>
      </View>
      </>}
      {v3 && expanded ? <View style={v3Styles.details}><Text testID="task-goal-objective" style={styles.objective}>{goal.objective}</Text></View> : null}
      {expanded && goal.blockerReason ? <Text style={styles.objective}>{goal.blockerReason}</Text> : null}
      {expanded && !goalCanEdit(goal) ? <Text testID="task-goal-terminal-readonly" style={styles.metrics}>{t("task.goal_terminal_readonly")}</Text> : null}
      {snapshot.goalContinuation?.reason ? <Text testID="task-goal-continuation" style={styles.metrics}>{snapshot.goalContinuation.reason}</Text> : null}
    </> : null}
    {todos.length ? <TodoCard todos={todos} current /> : null}
    {snapshot.goalError ? <View>
      <Text testID="task-goal-error" accessibilityRole="alert" style={styles.error}>{snapshot.goalError}</Text>
      <Button testID="task-goal-refresh" variant="secondary" disabled={busy || !snapshot.connected} onPress={() => void refresh(true)}>{t("task.goal_refresh")}</Button>
    </View> : null}
    <Modal visible={editingVisible} transparent animationType="slide" onRequestClose={() => { if (!busy) setEditing(null); }}>
      {editingVisible ? <KeyboardSafeView scope="modal" style={styles.overlay}><ScrollView accessibilityViewIsModal keyboardShouldPersistTaps="handled" style={styles.sheetScroll} contentContainerStyle={styles.sheet}>
        <View style={styles.summary}><Text style={[styles.title, styles.copy]}>{t("task.goal_edit")}</Text><Pressable testID="task-goal-edit-close" accessibilityRole="button" accessibilityLabel={t("common.close")} disabled={busy} onPress={() => setEditing(null)} style={styles.action}><X size={20} color={colors.textMuted} /></Pressable></View>
        <TextInput testID="task-goal-edit-input" accessibilityLabel={t("task.goal_edit")} value={objective} onChangeText={setObjective} multiline editable={!busy} style={styles.input} />
        <Text style={styles.metrics}>{t("task.goal_edit_note")}</Text>
        {editing && !editIsCurrent ? <Text testID="task-goal-edit-state-changed" accessibilityRole="alert" style={styles.error}>{snapshot.goalEditReadRequired ? t("task.goal_edit_refresh_required") : goal && !goalCanEdit(goal) ? t("task.goal_terminal_readonly") : t("task.goal_changed_refresh")}</Text> : null}
        {snapshot.goalEditReadRequired ? <Button testID="task-goal-edit-refresh" variant="secondary" disabled={busy || !snapshot.connected} onPress={() => void refresh(true)}>{t("task.goal_refresh")}</Button> : null}
        {snapshot.goalError ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.goalError}</Text> : null}
        <Button testID="task-goal-save" loading={busy} disabled={disabled || !objective.trim() || !editIsCurrent} onPress={() => { if (editing && editIsCurrent && editingOwner.current?.task === task && editingOwner.current.threadId === task.snapshot.threadId) void run(() => task.editGoal(objective, undefined, editing)); }}>{t("task.goal_save")}</Button>
      </ScrollView></KeyboardSafeView> : null}
    </Modal>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: spacing.xs, marginBottom: spacing.sm },
  summary: { flexDirection: "row", alignItems: "center", gap: spacing.sm }, copy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 12, fontWeight: "600" }, objective: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  metrics: { color: colors.textDim, fontSize: 11, lineHeight: 16 }, actions: { flexDirection: "row", alignItems: "center" },
  action: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, disabled: { opacity: 0.4 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 }, overlay: { flex: 1, justifyContent: "center", backgroundColor: colors.overlay, padding: spacing.lg },
  sheet: { backgroundColor: colors.surfaceRaised, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  sheetScroll: { flexGrow: 0, maxHeight: "100%" },
  input: { minHeight: 100, maxHeight: 200, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, padding: spacing.md, textAlignVertical: "top" },
});
