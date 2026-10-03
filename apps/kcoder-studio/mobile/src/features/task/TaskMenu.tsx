import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { requestConfirmation } from "@/platform/confirmation";
import { TaskRuntime } from "@/runtime/task-runtime";
import { colors } from "@/theme";
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
import { styles } from "./taskStyles";

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
      accessibilityLabel="任务操作"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.taskMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>任务操作</Text>
          <Pressable
            accessibilityLabel="关闭"
            onPress={onClose}
            style={styles.modalClose}
          >
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="任务标题"
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
          onPress={() => void run(() => task.rename(title), "标题已更新")}
          style={[styles.taskMenuRow, busy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>重命名</Text>
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
                  ? `上下文已压缩（${result.preTokens} → ${result.postTokens} tokens）`
                  : "当前上下文无需压缩",
            )
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuText}>压缩上下文</Text>
        </Pressable>
        {snapshot.archivedAt ? (
          <Pressable
            testID="unarchive-task-menu"
            disabled={busy}
            accessibilityState={{ disabled: busy }}
            onPress={() => void run(() => task.unarchive(), "任务已恢复")}
            style={[styles.taskMenuRow, busy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>恢复任务</Text>
          </Pressable>
        ) : (
          <Pressable
            testID="archive-task-menu"
            disabled={runningOrBusy}
            accessibilityState={{ disabled: runningOrBusy }}
            onPress={() =>
              requestConfirmation({
                title: "归档此任务？",
                message:
                  "任务将从最近列表移到已归档任务，并释放当前运行连接；之后仍可恢复查看。",
                confirmLabel: "归档",
                onConfirm: () =>
                  void run(async () => {
                    await task.archive();
                    onArchived();
                  }, "任务已归档"),
              })
            }
            style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
          >
            <Text style={styles.taskMenuText}>
              {snapshot.running ? "任务运行中，暂不能归档" : "归档任务"}
            </Text>
          </Pressable>
        )}
        <Pressable
          testID="delete-task"
          disabled={runningOrBusy}
          accessibilityState={{ disabled: runningOrBusy }}
          onPress={() =>
            requestConfirmation({
              title: "永久删除此任务？",
              message:
                "任务历史和本机保存的工作区界面状态都将被删除，此操作无法撤销。",
              confirmLabel: "永久删除",
              destructive: true,
              onConfirm: () =>
                void run(async () => {
                  await task.deleteThread();
                  await onDeleted();
                }, "任务已删除"),
            })
          }
          style={[styles.taskMenuRow, runningOrBusy && styles.sendDisabled]}
        >
          <Text style={styles.taskMenuDanger}>删除任务</Text>
        </Pressable>
        {busy ? <ActivityIndicator color={colors.textMuted} /> : null}
        {message ? <Text style={styles.taskMenuMessage}>{message}</Text> : null}
      </View>
    </Modal>
  );
}
