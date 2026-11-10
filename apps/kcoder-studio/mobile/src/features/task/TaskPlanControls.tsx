import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight, ListTodo, Pin, PinOff, X } from "lucide-react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import type { TaskSnapshot } from "@/runtime/task-runtime";
import { radius, spacing, useThemedStyles, type ThemeColors } from "@/theme";
import { useTaskAppearance } from "./taskStyles";
import { TaskMenuSheet } from "./TaskMenu";
import { TaskPlanItems } from "./TaskPlanCard";
import { latestTaskPlanMessage, taskPlanProgress } from "./task-plan";

type PlanView = { owner: object; turn: string; open: boolean; pinned: boolean };

/** Pinning is an opt-in view state for one owner and turn, never task authority. */
export function TaskPlanControls({ owner, snapshot, openRequest }: {
  owner: object; snapshot: TaskSnapshot; openRequest?: object;
}) {
  useLocale();
  const { colors } = useTaskAppearance();
  const styles = useThemedStyles(makeStyles);
  const plan = latestTaskPlanMessage(snapshot);
  const todos = plan?.todos ?? [];
  const turn = snapshot.activeTurnId ?? plan?.turnId ?? plan?.id ?? "";
  const { completed, total, next } = taskPlanProgress(todos);
  const canPin = snapshot.running && !snapshot.archivedAt && Boolean(next);
  const [view, setView] = useState<PlanView | null>(null);
  const current = view?.owner === owner && view.turn === turn ? view : null;
  const pinned = Boolean(current?.pinned && canPin);
  const handledRequest = useRef<object | undefined>(undefined);
  const changeView = (change: Partial<Pick<PlanView, "open" | "pinned">>) => setView(value => ({
    owner, turn, open: false, pinned: false,
    ...(value?.owner === owner && value.turn === turn ? value : {}), ...change,
  }));
  useEffect(() => {
    setView(value => value && (value.owner !== owner || value.turn !== turn) ? null : value);
  }, [owner, turn]);
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest || !total) return;
    handledRequest.current = openRequest;
    changeView({ open: true });
  }, [owner, turn, openRequest, total]);
  useEffect(() => {
    if (!canPin) setView(value => value?.pinned ? { ...value, pinned: false } : value);
  }, [canPin]);
  if (!total) return null;
  return <>
    {/* Retain Web input focus until a summary action completes, so shrinking cannot move its target. */}
    {pinned ? <View testID="task-plan-pinned" style={styles.summary}
      onPointerDown={Platform.OS === "web" ? event => event.preventDefault() : undefined}>
      <Pressable testID="task-plan-summary" accessibilityRole="button" accessibilityLabel={t("task.plan_menu", { done: completed, total })}
        onPress={() => changeView({ open: true })} style={styles.summaryOpen}>
        <ListTodo size={15} color={colors.textMuted} />
        <Text style={styles.progress}>{t("task.plan_compact", { done: completed, total })}</Text>
        <Text numberOfLines={1} style={styles.next}>{next?.content}</Text>
        <ChevronRight size={15} color={colors.textDim} />
      </Pressable>
      <Pressable testID="task-plan-unpin" accessibilityRole="button" accessibilityLabel={t("task.plan_unpin")}
        onPress={() => changeView({ pinned: false })} style={styles.action}><X size={16} color={colors.textMuted} /></Pressable>
    </View> : null}
    <TaskMenuSheet visible={Boolean(current?.open)} onClose={() => changeView({ open: false })}
      title={t("task.plan_progress", { done: completed, total })} testID="task-plan-sheet">
      {canPin ? <Pressable testID="task-plan-pin-toggle" accessibilityRole="button"
        onPress={() => changeView({ pinned: !pinned, open: false })} style={styles.pinAction}>
        {pinned ? <PinOff size={17} color={colors.textMuted} /> : <Pin size={17} color={colors.textMuted} />}
        <Text style={styles.pinText}>{t(pinned ? "task.plan_unpin" : "task.plan_pin")}</Text>
      </Pressable> : null}
      <View testID="task-plan-items"><TaskPlanItems todos={todos} /></View>
    </TaskMenuSheet>
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", marginHorizontal: spacing.md, marginBottom: spacing.xs,
    backgroundColor: colors.surface, borderRadius: radius.md },
  summaryOpen: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.md },
  progress: { color: colors.textMuted, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  next: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 12, lineHeight: 18 },
  action: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pinAction: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm },
  pinText: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
});
