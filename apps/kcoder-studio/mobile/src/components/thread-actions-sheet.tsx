import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Archive, ArchiveRestore, Pencil, Trash2, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GatewayProfile, KCoderServer, ThreadSummary } from "@/gateway/types";
import { deleteStoredThread, taskRuntimeRegistry, updateThreadMetadata, type TaskRuntime } from "@/runtime/task-runtime";
import { loadWorkspaceState, removeWorkspaceState } from "@/storage/workspace-preferences";
import { requestConfirmation } from "@/platform/confirmation";
import { colors, radius, spacing } from "@/theme";
import { useModalFocusTrap } from "./use-modal-focus-trap";
import { matchesLiveTaskTarget, threadCanBeArchivedOrDeleted } from "./thread-actions-policy";

export interface ThreadActionTarget {
  server: KCoderServer;
  thread: ThreadSummary;
}

export function ThreadActionsSheet({
  visible,
  profile,
  target,
  demo = false,
  onClose,
  onRenamed,
  onRemoved,
  liveTask,
  liveTaskServerId,
}: {
  visible: boolean;
  profile: GatewayProfile;
  target: ThreadActionTarget | null;
  demo?: boolean;
  onClose(): void;
  onRenamed(thread: ThreadSummary): void;
  onRemoved(kind: "archived" | "restored" | "deleted", thread: ThreadSummary): void;
  liveTask?: TaskRuntime;
  liveTaskServerId?: string;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  const modalRef = useModalFocusTrap(visible, close);
  const thread = target?.thread ?? null;
  const matchingTask = liveTask && target && thread && matchesLiveTaskTarget(target.server.id, thread.id, liveTaskServerId, liveTask.getSnapshot().threadId) ? liveTask : null;
  const liveSnapshot = useSyncExternalStore(
    matchingTask?.subscribe ?? subscribeNoop,
    matchingTask?.getSnapshot ?? getNullSnapshot,
    matchingTask?.getSnapshot ?? getNullSnapshot,
  );
  const destructiveAllowed = matchingTask ? !liveSnapshot?.running : thread ? threadCanBeArchivedOrDeleted(thread.status) : false;

  useEffect(() => {
    if (!visible || !thread) return;
    setTitle(thread.title || "未命名任务");
    setError(null);
  }, [thread?.id, thread?.title, visible]);

  const run = async (action: "rename" | "archive" | "delete") => {
    if (!target || busy) return;
    if (action !== "rename" && !destructiveAllowed) {
      setError("任务仍在运行或等待交互，请先打开任务并停止当前回合。");
      return;
    }
    const nextTitle = title.trim();
    if (action === "rename" && !nextTitle) {
      setError("任务标题不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action === "rename") {
        if (matchingTask) await matchingTask.rename(nextTitle);
        else if (!demo) await updateThreadMetadata(profile, target.server, thread!.id, { title: nextTitle }, thread!.cwd);
        onRenamed({ ...thread!, title: nextTitle });
      } else if (action === "archive") {
        const restored = Boolean(thread!.archivedAt);
        const archivedAt = restored ? undefined : new Date().toISOString();
        if (matchingTask) {
          if (restored) await matchingTask.unarchive();
          else await matchingTask.archive();
        } else if (!demo) await updateThreadMetadata(profile, target.server, thread!.id, { archivedAt: archivedAt ?? null }, thread!.cwd);
        taskRuntimeRegistry.remove(profile.id, target.server.id, thread!.id);
        onRemoved(restored ? "restored" : "archived", { ...thread!, archivedAt });
        onClose();
      } else {
        const workspaceState = await loadWorkspaceState(profile.id, target.server.id, thread!.id).catch(() => null);
        const attachmentPaths = workspaceState?.queuedMessages?.flatMap((message) => message.attachments.map((attachment) => attachment.path)) ?? [];
        if (matchingTask) {
          await matchingTask.deleteThread();
          for (const path of attachmentPaths) await matchingTask.request("attachment/delete", { path }).catch(() => {});
        } else if (!demo) {
          await deleteStoredThread(profile, target.server, thread!.id, thread!.cwd, attachmentPaths);
        }
        await removeWorkspaceState(profile.id, target.server.id, thread!.id).catch(() => {});
        taskRuntimeRegistry.remove(profile.id, target.server.id, thread!.id);
        onRemoved("deleted", thread!);
        onClose();
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType={Platform.OS === "web" ? "none" : "slide"} accessibilityLabel="任务操作" onRequestClose={close}>
      <Pressable accessibilityLabel="关闭任务操作" style={styles.overlay} onPress={close} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} pointerEvents="box-none" style={styles.keyboard}>
        <View ref={modalRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.header}><View style={styles.heading}><Text numberOfLines={1} style={styles.title}>{thread?.title || "未命名任务"}</Text><Text numberOfLines={1} style={styles.subtitle}>{target?.server.label} · {thread?.cwd ?? target?.server.workspacePath ?? "/"}</Text></View><Pressable accessibilityLabel="关闭" disabled={busy} onPress={close} style={styles.close}><X size={20} color={colors.textMuted} /></Pressable></View>
          <View style={styles.renameRow}><TextInput testID="thread-rename-input" value={title} onChangeText={setTitle} editable={!busy} placeholder="任务标题" placeholderTextColor={colors.textDim} style={styles.renameInput} /><Pressable testID="thread-rename-save" accessibilityLabel="保存任务标题" disabled={busy || !title.trim()} onPress={() => void run("rename")} style={[styles.renameSave, (busy || !title.trim()) && styles.disabled]}>{busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Pencil size={17} color={colors.text} />}</Pressable></View>
          <Pressable testID="thread-archive-action" disabled={busy || !destructiveAllowed} accessibilityState={{ disabled: busy || !destructiveAllowed }} onPress={() => void run("archive")} style={[styles.action, !destructiveAllowed && styles.disabled]}>{thread?.archivedAt ? <ArchiveRestore size={19} color={colors.textMuted} /> : <Archive size={19} color={colors.textMuted} />}<View style={styles.actionCopy}><Text style={styles.actionTitle}>{thread?.archivedAt ? "恢复任务" : "归档任务"}</Text><Text style={styles.actionBody}>{destructiveAllowed ? thread?.archivedAt ? "移回最近任务并允许继续对话" : "从最近列表隐藏，历史仍可恢复" : "任务运行中或等待交互，暂不可操作"}</Text></View></Pressable>
          <Pressable testID="thread-delete-action" disabled={busy || !destructiveAllowed} accessibilityState={{ disabled: busy || !destructiveAllowed }} onPress={() => requestConfirmation({ title: "永久删除任务？", message: thread?.title || "未命名任务", confirmLabel: "永久删除", destructive: true, onConfirm: () => void run("delete") })} style={[styles.action, !destructiveAllowed && styles.disabled]}><Trash2 size={19} color={colors.red} /><View style={styles.actionCopy}><Text style={styles.danger}>永久删除</Text><Text style={styles.actionBody}>{destructiveAllowed ? "删除任务历史和本地界面状态，此操作无法撤销" : "任务运行中或等待交互，暂不可操作"}</Text></View></Pressable>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const subscribeNoop = () => () => {};
const getNullSnapshot = () => null;

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  keyboard: { ...StyleSheet.absoluteFillObject },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "84%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderAccent, backgroundColor: colors.surface },
  header: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: spacing.md },
  heading: { flex: 1 },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  subtitle: { color: colors.textDim, fontSize: 10, marginTop: 4 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  renameRow: { minHeight: 50, flexDirection: "row", gap: spacing.sm },
  renameInput: { flex: 1, minHeight: 48, color: colors.text, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background },
  renameSave: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.surfaceRaised },
  disabled: { opacity: 0.4 },
  action: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.background },
  actionCopy: { flex: 1 },
  actionTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  danger: { color: colors.red, fontSize: 13, fontWeight: "700" },
  actionBody: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 },
});
