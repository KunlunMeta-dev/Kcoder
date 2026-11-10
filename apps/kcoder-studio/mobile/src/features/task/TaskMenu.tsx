import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { requestConfirmation } from "@/platform/confirmation";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { Button } from "@/components/ui";
import { Archive, ArchiveRestore, Bot, ChevronLeft, ChevronRight, ListChecks, Minimize2, PanelsTopLeft, Pencil, Search, Settings2, Shield, Sparkles, Trash2, X, type LucideIcon } from "lucide-react-native";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTaskAppearance } from "./taskStyles";
import { canChangePermission } from "./task-permission-availability";
import { latestTaskPlan, taskPlanProgress } from "./task-plan";

export function TaskMenuAction({ testID, icon: Icon, label, detail, onPress, disabled = false, danger = false, opensPage = false }: {
  testID: string; icon: LucideIcon; label: string; detail?: string; onPress?(): void;
  disabled?: boolean; danger?: boolean; opensPage?: boolean;
}) {
  const { styles, colors } = useTaskAppearance();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={[label, detail].filter(Boolean).join(" · ")}
    disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
    style={({ pressed }) => [styles.taskMenuAction, disabled && styles.sendDisabled, pressed && styles.taskMenuPressed]}>
    <Icon size={20} color={danger ? colors.red : colors.textMuted} />
    <View style={styles.taskMenuActionCopy}>
      <Text style={danger ? styles.taskMenuDanger : styles.taskMenuText}>{label}</Text>
      {detail ? <Text style={styles.taskMenuDetail}>{detail}</Text> : null}
    </View>
    {opensPage ? <ChevronRight size={18} color={colors.textDim} /> : null}
  </Pressable>;
}

export function TaskPermissionMenuItem({ onPress, disabled = false, permissionLabel }: {
  onPress?(): void; disabled?: boolean; permissionLabel?: string;
}) {
  const unavailable = disabled || !onPress;
  return <TaskMenuAction testID="v3-menu-permissions" icon={Shield} label={t("task.permission_mode")}
    detail={permissionLabel} disabled={unavailable} onPress={onPress} opensPage />;
}

export function TaskExpertMenuItem({ onPress, disabled = false, detail }: {
  onPress?(): void; disabled?: boolean; detail?: string;
}) {
  const unavailable = disabled || !onPress;
  return <TaskMenuAction testID="task-menu-expert" icon={Bot} label={t("expert.select")}
    detail={detail} disabled={unavailable} onPress={onPress} opensPage={!unavailable} />;
}

export function TaskMenuSheet({ visible, onClose, onBack, children, title, testID, initialFocusSelector }: {
  visible: boolean; onClose(): void; onBack?(): void; children: ReactNode; title?: string; testID?: string; initialFocusSelector?: string;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const modalRef = useModalFocusTrap(visible, onBack ?? onClose, initialFocusSelector, Boolean(onBack));
  return <Modal visible={visible} transparent animationType={Platform.OS === "web" ? "none" : "slide"}
    accessibilityLabel={title ?? t("task.task_actions")} onRequestClose={onBack ?? onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.taskMenuOverlay}>
    <Pressable style={styles.sheetOverlay} onPress={onClose} />
    <View ref={modalRef} testID={testID ?? "task-menu-sheet"} role="dialog" accessibilityViewIsModal style={styles.taskMenu}>
      <View style={styles.attachmentSheetHeader}>
        {onBack ? <Pressable testID="task-menu-back" accessibilityRole="button" accessibilityLabel={t("task.back")}
          onPress={onBack} style={styles.modalClose}><ChevronLeft size={20} color={colors.textMuted} /></Pressable> : null}
        <Text style={[styles.attachmentSheetTitle, styles.taskMenuActionCopy]}>{title ?? t("task.task_actions")}</Text>
        <Pressable testID={testID ? `${testID}-close` : "task-menu-close"} accessibilityRole="button" accessibilityLabel={t("task.close")}
          onPress={onClose} style={styles.modalClose}><X size={20} color={colors.textMuted} /></Pressable>
      </View>
      <ScrollView testID="task-menu-content" style={styles.taskMenuScroll} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </View>
    </KeyboardAvoidingView>
  </Modal>;
}

export function TaskNavigationItems({ onSearch, onWorkspace, onQuickPhrases, quickPhrasesDisabled }: {
  onSearch?(): void; onWorkspace?(): void; onQuickPhrases?(): void; quickPhrasesDisabled?: boolean;
}) {
  useLocale();
  return <>
    {onSearch ? <TaskMenuAction testID="task-menu-search" icon={Search} label={t("task.search_loaded_body")} onPress={onSearch} opensPage /> : null}
    {onWorkspace ? <TaskMenuAction testID="task-menu-workspace" icon={PanelsTopLeft} label={t("task.workspace_tabs")} onPress={onWorkspace} opensPage /> : null}
    {onQuickPhrases ? <TaskMenuAction testID="task-quick-phrases" icon={Sparkles} label={t("settings_personalization.open_quick_phrases")}
      disabled={quickPhrasesDisabled} onPress={onQuickPhrases} opensPage /> : null}
  </>;
}

export function TaskMenu({
  visible,
  task,
  demo,
  onClose,
  onArchived,
  onDeleted,
  onSubagents,
  onExpert,
  onSearch,
  onWorkspace,
  onQuickPhrases,
  onPermission,
  onPlan,
}: {
  visible: boolean;
  task: TaskRuntime;
  demo: boolean;
  onClose(): void;
  onArchived(): void;
  onDeleted(): void | Promise<void>;
  onSubagents?(): void;
  onExpert?(): void;
  onSearch?(): void;
  onWorkspace?(): void;
  onQuickPhrases?(): void;
  onPermission?(): void;
  onPlan?(): void;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  const [title, setTitle] = useState(snapshot.title);
  const [busy, setBusy] = useState(false);
  const [menuPage, setMenuPage] = useState<"main" | "manage" | "rename">("main");
  const editingTitle = menuPage === "rename";
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setTitle(snapshot.title);
    setMessage(null);
  }, [snapshot.title, visible]);
  useEffect(() => { setMenuPage("main"); }, [visible]);
  const run = async <T,>(
    action: () => Promise<T>,
    success: string | ((result: T) => string),
    close = false,
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage(typeof success === "function" ? success(result) : success);
      if (close) onClose();
      else if (editingTitle) setMenuPage("manage");
    } catch (value) {
      setMessage(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const runningOrBusy = busy || snapshot.running;
  const plan = onPlan ? taskPlanProgress(latestTaskPlan(snapshot)) : { completed: 0, total: 0 };
  const expertUnavailable = !onExpert ? undefined : snapshot.archivedAt ? "archived"
    : !snapshot.connected ? "disconnected"
    : snapshot.configurationReady === false ? "loading"
    : !task.supportsExperts() ? "unsupported" : undefined;
  return (
    <TaskMenuSheet visible={visible} onClose={() => { if (!busy) onClose(); }}
      title={editingTitle ? t("task.rename") : menuPage === "manage" ? t("task.manage_conversation") : undefined}
      onBack={menuPage !== "main" ? () => { if (!busy) { setMenuPage(editingTitle ? "manage" : "main"); setMessage(null); } } : undefined}
      initialFocusSelector={editingTitle ? '[data-testid="task-rename-input"]' : menuPage === "manage" ? '[data-testid="rename-task"]' : undefined}>
      {editingTitle ? <View testID="task-rename-details" style={styles.taskMenuEditor}>
        <Text style={styles.taskMenuText}>{t("task.task_title")}</Text>
        <TextInput testID="task-rename-input" accessibilityLabel={t("task.task_title")} editable={!busy}
          accessibilityState={{ disabled: busy }} value={title} onChangeText={setTitle} returnKeyType="done"
          onSubmitEditing={() => { if (!busy && title.trim()) void run(() => task.rename(title.trim()), t("task.title_updated")); }}
          style={[styles.taskTitleInput, busy && styles.sendDisabled]} />
        <View style={styles.taskMenuEditorActions}>
          <Button testID="cancel-task-rename" disabled={busy} onPress={() => { setMenuPage("manage"); setMessage(null); }}>{t("common.cancel")}</Button>
          <Button testID="save-task-title" variant="primary" disabled={busy || !title.trim()} loading={busy}
            onPress={() => void run(() => task.rename(title.trim()), t("task.title_updated"))}>{t("common.save")}</Button>
        </View>
      </View> : menuPage === "manage" ? <>
        <TaskMenuAction testID="rename-task" icon={Pencil} label={t("task.rename")} opensPage disabled={busy}
          onPress={() => { setTitle(snapshot.title); setMessage(null); setMenuPage("rename"); }} />
        <TaskMenuAction testID="compact-task" icon={Minimize2} label={t("task.compact_context")} disabled={runningOrBusy}
          onPress={() => void run(() => task.compact(), result => result.compacted
            ? t("task.context_compacted_tokens", { p0: result.preTokens, p1: result.postTokens })
            : t("task.the_current_context_does_not_need_compaction"))} />
        {snapshot.archivedAt ? <TaskMenuAction testID="unarchive-task-menu" icon={ArchiveRestore}
          label={t("task.restore_task")} disabled={busy}
          onPress={() => void run(() => task.unarchive(), t("task.task_restored"))} />
          : <TaskMenuAction testID="archive-task-menu" icon={Archive} label={t("task.archive_task")} disabled={runningOrBusy}
            onPress={() => requestConfirmation({
              title: t("task.archive_this_task"), message: t("task.the_task_will_move_from_recent_tasks_to"),
              confirmLabel: t("task.archive"), onConfirm: () => void run(async () => {
                await task.archive(); onArchived();
              }, t("task.task_archived")),
            })} />}
        <TaskMenuAction testID="delete-task" icon={Trash2} label={t("task.delete_task")} danger disabled={runningOrBusy}
          onPress={() => requestConfirmation({
            title: t("task.permanently_delete_this_task"), message: t("task.task_history_and_this_devices_saved_workspace_interface"),
            confirmLabel: t("task.delete_permanently"), destructive: true,
            onConfirm: () => void run(async () => { await task.deleteThread(); await onDeleted(); }, t("task.task_deleted")),
          })} />
      </> : <>
        {onPlan && plan.total ? <TaskMenuAction testID="task-menu-plan" icon={ListChecks}
          label={t("task.plan_menu", { done: plan.completed, total: plan.total })} opensPage
          onPress={() => { onClose(); onPlan(); }} /> : null}
        {onExpert ? <TaskExpertMenuItem disabled={Boolean(expertUnavailable)}
          detail={expertUnavailable ? t(`expert.status_${expertUnavailable}`) : undefined}
          onPress={() => { onClose(); onExpert(); }} /> : null}
        {onPermission ? <TaskPermissionMenuItem disabled={busy || !canChangePermission(task, snapshot)}
          permissionLabel={t(`task.permission_mode_${snapshot.permissionMode ?? "default"}`)}
          onPress={() => { onClose(); onPermission(); }} /> : null}
        <TaskNavigationItems onSearch={onSearch} onWorkspace={onWorkspace} onQuickPhrases={onQuickPhrases}
          quickPhrasesDisabled={busy || !snapshot.connected || snapshot.configurationReady === false || Boolean(snapshot.archivedAt)} />
        {onSubagents && task.agentCapabilities().discover ? <TaskMenuAction testID="mobile-subagents-open" icon={Bot}
          label={t("task.view_subagents")} onPress={onSubagents} opensPage disabled={busy} /> : null}
        <TaskMenuAction testID="task-menu-management" icon={Settings2} label={t("task.manage_conversation")}
          onPress={() => { setMessage(null); setMenuPage("manage"); }} opensPage disabled={busy} />
      </>}
      {busy && !editingTitle ? <ActivityIndicator color={colors.textMuted} /> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.taskMenuMessage}>{message}</Text> : null}
    </TaskMenuSheet>
  );
}
