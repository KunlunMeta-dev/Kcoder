import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { requestConfirmation } from "@/platform/confirmation";
import { TaskRuntime } from "@/runtime/task-runtime";
import { X } from "lucide-react-native";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTaskAppearance } from "./taskStyles";

export function TaskMenu({
  visible,
  task,
  demo,
  onClose,
  onArchived,
  onDeleted,
}: {
  visible: boolean;
  task: TaskRuntime;
  demo: boolean;
  onClose(): void;
  onArchived(): void;
  onDeleted(): void | Promise<void>;
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
  const [message, setMessage] = useState<string | null>(null);
  const modalRef = useModalFocusTrap(visible, onClose);
  useEffect(() => {
    if (!visible) return;
    setTitle(snapshot.title);
    setMessage(null);
  }, [snapshot.title, visible]);
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
    } catch (value) {
      setMessage(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const runningOrBusy = busy || snapshot.running;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      accessibilityLabel={t("task.task_actions")}
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.taskMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>
            {t("task.task_actions")}
          </Text>
          <Pressable
            accessibilityLabel={t("task.close")}
            onPress={onClose}
            style={styles.modalClose}
          >
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel={t("task.task_title")}
          editable={!busy}
          accessibilityState={{ disabled: busy }}
          value={title}
          onChangeText={setTitle}
          style={[styles.taskTitleInput, busy && styles.sendDisabled]}
        />
        <Pressable
          testID="rename-task"
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          onPress={() =>
            void run(() => task.rename(title), t("task.title_updated"))
          }
          style={[styles.taskMenuRow, busy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>{t("task.rename")}</Text>
        </Pressable>
        <Pressable
          testID="compact-task"
          disabled={runningOrBusy}
          accessibilityState={{ disabled: runningOrBusy }}
          onPress={() =>
            void run(
              () => task.compact(),
              (result) =>
                result.compacted
                  ? t("task.context_compacted_tokens", {
                      p0: result.preTokens,
                      p1: result.postTokens,
                    })
                  : t("task.the_current_context_does_not_need_compaction"),
            )
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>{t("task.compact_context")}</Text>
        </Pressable>
        {snapshot.archivedAt ? (
          <Pressable
            testID="unarchive-task-menu"
            disabled={busy}
            accessibilityState={{ disabled: busy }}
            onPress={() =>
              void run(() => task.unarchive(), t("task.task_restored"))
            }
            style={[styles.taskMenuRow, busy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>{t("task.restore_task")}</Text>
          </Pressable>
        ) : (
          <Pressable
            testID="archive-task-menu"
            disabled={runningOrBusy}
            accessibilityState={{ disabled: runningOrBusy }}
            onPress={() =>
              requestConfirmation({
                title: t("task.archive_this_task"),
                message: t("task.the_task_will_move_from_recent_tasks_to"),
                confirmLabel: t("task.archive"),
                onConfirm: () =>
                  void run(async () => {
                    await task.archive();
                    onArchived();
                  }, t("task.task_archived")),
              })
            }
            style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>
              {snapshot.running
                ? t("task.this_task_is_running_and_cannot_be_archived")
                : t("task.archive_task")}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="delete-task"
          disabled={runningOrBusy}
          accessibilityState={{ disabled: runningOrBusy }}
          onPress={() =>
            requestConfirmation({
              title: t("task.permanently_delete_this_task"),
              message: t(
                "task.task_history_and_this_devices_saved_workspace_interface",
              ),
              confirmLabel: t("task.delete_permanently"),
              destructive: true,
              onConfirm: () =>
                void run(async () => {
                  await task.deleteThread();
                  await onDeleted();
                }, t("task.task_deleted")),
            })
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuDanger}>{t("task.delete_task")}</Text>
        </Pressable>
        {busy ? <ActivityIndicator color={colors.textMuted} /> : null}
        {message ? <Text style={styles.taskMenuMessage}>{message}</Text> : null}
      </View>
    </Modal>
  );
}
