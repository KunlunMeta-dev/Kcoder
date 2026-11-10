import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { GitFork, Pencil, X } from "lucide-react-native";
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from "react-native";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type { TranscriptActionRecord } from "@/storage/transcript-action";
import { canChangeTranscript, completedForkMessage, lastEditableMessage } from "@/runtime/task-runtime/transcriptActions";
import { copyAssistantText } from "./transcript-actions";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { t } from "@/i18n";
import { spacing, radius } from "@/theme";
import { useTaskAppearance } from "./taskStyles";

export function useTranscriptActions(task: TaskRuntime, enabled: boolean) {
  const router = useRouter();
  const { colors } = useTaskAppearance();
  const [sheet, setSheet] = useState<{ kind: "edit" | "fork" | "recover"; messageId?: string } | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<TranscriptActionRecord>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const owner = useRef({ task, enabled });
  owner.current = { task, enabled };
  const current = () => alive.current && owner.current.task === task && owner.current.enabled;
  const reload = async () => {
    const next = await task.pendingTranscriptAction();
    if (current()) setPending(next);
    return next;
  };
  useEffect(() => {
    alive.current = true;
    if (enabled) {
      task.patch({ transcriptActionPending: true });
      void reload().catch(value => { if (current()) setError(String(value)); });
    }
    return () => { alive.current = false; };
  }, [task, enabled]);
  const close = () => { if (!inFlight.current) { setSheet(null); setError(null); } };
  const openFork = (childThreadId: string) => {
    const context = task.reconnectContext;
    if (!context || task.disposed) return;
    router.push({ pathname: "/h/[profileId]/task/[serverId]/[threadId]", params: {
      profileId: context.profile.id, serverId: context.server.id, threadId: childThreadId, cwd: task.snapshot.cwd,
    } });
  };
  const run = async (action: () => Promise<string | void>, dismiss = true) => {
    if (inFlight.current || !enabled) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const child = await action();
      if (child && current()) {
        openFork(child);
        await task.dismissTranscriptAction();
      }
      const next = await reload();
      if (current() && dismiss && !next) setSheet(null);
    } catch (value) {
      if (current()) setError(value instanceof Error ? value.message : String(value));
      try { await reload(); } catch { /* Keep the durable record and the original error visible. */ }
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  };
  const snapshot = task.getSnapshot();
  const editable = enabled ? lastEditableMessage(snapshot) : undefined;
  const forkIds = new Set<string>();
  if (enabled && canChangeTranscript(snapshot)) {
    const lastByTurn = new Map<string, string>();
    for (const message of snapshot.messages) if (completedForkMessage(message)) lastByTurn.set(message.turnId!, message.id);
    for (const id of lastByTurn.values()) forkIds.add(id);
  }
  return {
    editableId: editable?.id,
    forkIds,
    onEdit: (messageId: string) => {
      const latest = lastEditableMessage(task.getSnapshot());
      if (!enabled || latest?.id !== messageId) return;
      setText(latest.content); setError(null); setSheet({ kind: "edit", messageId });
    },
    onFork: (messageId: string) => { if (forkIds.has(messageId)) { setError(null); setSheet({ kind: "fork", messageId }); } },
    recovery: pending || error ? <Pressable testID="transcript-action-recovery" accessibilityRole="button"
      onPress={() => { setText(pending?.text ?? ""); setSheet({ kind: "recover" }); }}
      style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t("task.transcript_action_review")}</Text>
    </Pressable> : null,
    dialog: <TranscriptActionSheet visible={Boolean(sheet)} kind={sheet?.kind ?? "recover"} text={text} onText={setText}
      pending={pending} error={error} busy={busy} onClose={close}
      onConfirm={() => void run(() => pending ? task.recoverTranscriptAction() : sheet?.kind === "edit" ? task.editLastMessage(sheet.messageId!, text)
        : sheet?.kind === "fork" ? task.forkCompletedTurn(sheet.messageId!) : task.recoverTranscriptAction())}
      onAcknowledge={() => void run(() => task.dismissTranscriptAction())}
      onCopy={() => void copyAssistantText(pending?.text ?? text)} />,
  };
}

function TranscriptActionSheet({ visible, kind, text, onText, pending, error, busy, onClose, onConfirm, onAcknowledge, onCopy }: {
  visible: boolean; kind: "edit" | "fork" | "recover"; text: string; onText(value: string): void;
  pending?: TranscriptActionRecord; error: string | null; busy: boolean;
  onClose(): void; onConfirm(): void; onAcknowledge(): void; onCopy(): void;
}) {
  const { styles, colors } = useTaskAppearance();
  const ref = useModalFocusTrap(visible, onClose);
  const recover = kind === "recover" || Boolean(pending);
  const title = t(kind === "edit" && !recover ? "task.edit_last_message" : kind === "fork" && !recover ? "task.fork_at_turn" : "task.transcript_action_review");
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} accessibilityLabel={title}>
    <Pressable style={styles.sheetOverlay} onPress={onClose} />
    <View ref={ref} testID="transcript-action-sheet" style={[styles.taskMenu, { borderRadius: radius.settingsGroup, padding: spacing.lg, gap: spacing.md }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        {kind === "fork" ? <GitFork size={18} color={colors.textMuted} /> : <Pencil size={18} color={colors.textMuted} />}
        <Text style={[styles.attachmentSheetTitle, { flex: 1 }]}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("task.close")} disabled={busy} onPress={onClose} style={styles.modalClose}>
          <X size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20 }}>
        {t(recover ? "task.transcript_recovery_hint" : kind === "edit" ? "task.edit_last_message_hint" : "task.fork_at_turn_hint")}
      </Text>
      {kind === "edit" && !recover ? <TextInput testID="edit-last-message-input" multiline value={text} onChangeText={onText}
        maxLength={50_000} editable={!busy} accessibilityLabel={t("task.edit_last_message")}
        style={{ minHeight: 100, maxHeight: 260, padding: spacing.md, borderWidth: 1,
          borderColor: colors.border, borderRadius: radius.xl, color: colors.text, fontSize: 16, textAlignVertical: "top" }} /> : null}
      {error ? <Text testID="transcript-action-error" accessibilityRole="alert" style={{ color: colors.red, fontSize: 13 }}>{error}</Text> : null}
      {recover && pending?.text ? <Pressable accessibilityRole="button" onPress={onCopy} style={styles.modalClose}>
        <Text style={{ color: colors.textMuted }}>{t("task.copy_edited_message")}</Text>
      </Pressable> : null}
      <Pressable testID="transcript-action-confirm" accessibilityRole="button"
        disabled={busy || (kind === "edit" && !recover && !text.trim())} onPress={onConfirm}
        style={[styles.cacheRetryButton, { minHeight: 44 }]}>
        {busy ? <ActivityIndicator color={colors.textMuted} /> : <Text style={styles.cacheRetryText}>
          {t(recover ? "task.transcript_check_or_continue" : kind === "edit" ? "task.edit_and_resend" : "task.fork_at_turn")}
        </Text>}
      </Pressable>
      {recover && pending ? <Pressable testID="transcript-action-acknowledge" accessibilityRole="button" disabled={busy}
        onPress={onAcknowledge} style={{ paddingVertical: spacing.sm }}>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t("task.transcript_acknowledge")}</Text>
      </Pressable> : null}
    </View>
  </Modal>;
}
