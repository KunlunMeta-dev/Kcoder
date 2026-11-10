import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, Bot, ChevronRight, Info, MoreHorizontal, RefreshCw, History } from "lucide-react-native";
import { t } from "@/i18n";
import { spacing, radius, useTheme } from "@/theme";
import type { AgentSummary } from "@/runtime/task-runtime/types";
import type { AgentPage } from "@/runtime/task-runtime/agents";
import { ConversationV3Background } from "@/features/interface/ConversationV3";
import { MessageBubble } from "./MessageBubble";
import { TaskMenuSheet } from "./TaskMenu";
import { useTaskAppearance } from "./taskStyles";

export function subagentStatusLabel(status: string): string {
  if (["running", "active"].includes(status)) return t("inbox.subagent_running");
  if (["completed", "complete", "done"].includes(status)) return t("inbox.subagent_completed");
  if (["failed", "error"].includes(status)) return t("inbox.subagent_failed");
  if (status === "paused") return t("task.paused");
  if (["cancelled", "canceled"].includes(status)) return t("task.cancelled");
  return t("inbox.subagent_other");
}

/** Presentation only: the caller retains all connection, receipt and ownership gates. */
export function TaskSubagentPanel({ visible, onBack, onRefresh, refreshDisabled, bottomInset, title, information, children, scrollable = true, onHistory, onLive, historyDisabled = refreshDisabled }: {
  visible: boolean; onBack(): void; onRefresh(): void; refreshDisabled: boolean;
  bottomInset: number; title?: string; children: ReactNode;
  information?: { agentId: string; directory: string; goal?: string };
  scrollable?: boolean;
  onHistory?(): void;
  onLive?(): void;
  historyDisabled?: boolean;
}) {
  const { colors } = useTheme();
  const { styles: menuStyles } = useTaskAppearance();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showInformation, setShowInformation] = useState(false);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = visible && menuOpen;
  useEffect(() => { setMenuOpen(false); setShowInformation(false); }, [visible, title, information?.agentId]);
  useEffect(() => {
    if (Platform.OS !== "web" || !visible || typeof document === "undefined") return;
    // The sheet closes on keydown; prevent its keyup from dismissing the outer Modal.
    let menuConsumedEscape = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpenRef.current) menuConsumedEscape = true;
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menuConsumedEscape) return;
      menuConsumedEscape = false;
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", keyup, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true);
    };
  }, [visible]);
  return <Modal visible={visible} animationType="slide" onRequestClose={onBack}>
    <SafeAreaView testID="mobile-subagent-panel" style={[styles.root, { backgroundColor: colors.background }]} edges={["top", "left", "right"]}>
      <ConversationV3Background />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("task.back")} testID="mobile-subagent-back" onPress={onBack} style={styles.icon}>
            <ArrowLeft size={22} color={colors.text} />
          </Pressable>
          <View style={styles.heading}><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title || t("task.subagents")}</Text></View>
          <Pressable testID="mobile-subagent-more" accessibilityRole="button" accessibilityLabel={t("task.more")}
            accessibilityState={{ expanded: visible && menuOpen }} aria-expanded={visible && menuOpen}
            onPress={() => { setShowInformation(false); setMenuOpen(true); }} style={styles.icon}>
            <MoreHorizontal size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        {scrollable ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, paddingBottom: Math.max(bottomInset, spacing.md) }}>
          {children}
        </ScrollView> : children}
      </KeyboardAvoidingView>
      <TaskMenuSheet visible={visible && menuOpen} title={t(showInformation && information ? "task.subagent_information" : "task.more")}
        testID={showInformation && information ? "mobile-subagent-information" : "mobile-subagent-menu"} onClose={() => setMenuOpen(false)}>
        {showInformation && information ? <View style={styles.context}>
          {information.goal ? <View style={styles.informationField}>
            <Text style={[styles.secondary, { color: colors.textMuted }]}>{t("task.subagent_goal")}</Text>
            <Text selectable style={[styles.secondary, { color: colors.text }]}>{information.goal}</Text>
          </View> : null}
          <View style={styles.informationField}>
            <Text style={[styles.secondary, { color: colors.textMuted }]}>{t("task.subagent_directory")}</Text>
            <Text selectable style={[styles.secondary, { color: colors.text }]}>{information.directory}</Text>
          </View>
        </View> : <>
        {onHistory || onLive ? <Pressable testID="mobile-subagent-history" accessibilityRole="button"
          disabled={historyDisabled} accessibilityState={{ disabled: historyDisabled }}
          onPress={() => { setMenuOpen(false); (onLive ?? onHistory)?.(); }} style={[menuStyles.taskMenuRow, styles.menuRow]}>
          <History size={18} color={colors.textMuted} /><Text style={menuStyles.taskMenuText}>{t(onLive ? "task.live" : "task.history")}</Text>
        </Pressable> : null}
        {information ? <Pressable testID="mobile-subagent-information-open" accessibilityRole="button"
          onPress={() => setShowInformation(true)} style={[menuStyles.taskMenuRow, styles.menuRow]}>
          <Info size={18} color={colors.textMuted} /><Text style={menuStyles.taskMenuText}>{t("task.subagent_information")}</Text>
        </Pressable> : null}
        <Pressable testID="mobile-subagent-refresh" accessibilityRole="button" accessibilityLabel={t("task.refresh")}
          accessibilityState={{ disabled: refreshDisabled }} disabled={refreshDisabled}
          onPress={() => { setMenuOpen(false); onRefresh(); }}
          style={[menuStyles.taskMenuRow, styles.menuRow, refreshDisabled && { opacity: .45 }]}>
          <RefreshCw size={18} color={colors.textMuted} /><Text style={menuStyles.taskMenuText}>{t("task.refresh")}</Text>
        </Pressable>
        </>}
      </TaskMenuSheet>
    </SafeAreaView>
  </Modal>;
}

export function TaskSubagentList({ agents, onChoose, pendingCount }: {
  agents: AgentSummary[]; onChoose(id: string): void; pendingCount(id: string): number;
}) {
  const { colors } = useTheme();
  return <View testID="mobile-subagent-list">
    {agents.length ? agents.map(agent => <Pressable key={agent.agentId} accessibilityRole="button"
      testID={`mobile-subagent-${agent.agentId}`} onPress={() => onChoose(agent.agentId)}
      style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={[styles.avatar, { backgroundColor: colors.surface }]}><Bot size={21} color={colors.textMuted} /></View>
      <View style={styles.name}><Text numberOfLines={2} style={[styles.rowTitle, { color: colors.text }]}>{agent.agentName || agent.presentation?.goal || agent.agentId}</Text>
        <Text style={[styles.secondary, { color: colors.textMuted }]}>{subagentStatusLabel(agent.status)}{pendingCount(agent.agentId) ? ` · ${t("inbox.subagent_pending_count", { p0: pendingCount(agent.agentId) })}` : ""}</Text>
      </View>
      <ChevronRight size={17} color={colors.textMuted} />
    </Pressable>) : <Text style={[styles.secondary, { color: colors.textMuted }]}>{t("task.no_subagents_to_display")}</Text>}
  </View>;
}

export function TaskSubagentTranscript({ agent, page, parentTitle, targetLabel, directory, onParent }: {
  agent: AgentSummary; page: AgentPage | null; parentTitle: string; targetLabel: string; directory: string; onParent(): void;
}) {
  const { colors } = useTheme();
  return <View testID="mobile-subagent-conversation">
    <Pressable testID="mobile-subagent-parent" accessibilityRole="button" onPress={onParent} style={styles.parent}>
      <ArrowLeft size={15} color={colors.textMuted} /><Text numberOfLines={1} style={[styles.parentText, { color: colors.textMuted }]}>{t("inbox.subagent_parent", { p0: parentTitle })}</Text>
    </Pressable>
    <View style={styles.summary}>
      <Text style={[styles.secondary, { color: colors.textMuted }]}>{subagentStatusLabel(agent.status)} · {targetLabel}</Text>
    </View>
    {/* Artifact APIs supply public text, not structured chat events. Preserve it verbatim. */}
    {page === null ? <ActivityIndicator color={colors.textMuted} /> : page.content ?
      <MessageBubble key={agent.agentId} message={{ id: `agent-public-${agent.agentId}`, role: "assistant", content: page.content, timestampMs: 0 }}
        readOnly connected={false} continuationBusy={false} cwd={directory} onOpenFile={() => false} onOpenChanges={() => {}} /> :
      <Text style={[styles.secondary, { color: colors.textMuted }]}>{t("task.no_public_transcript")}</Text>}
  </View>;
}

export function TaskSubagentInstructionInput({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }) {
  const { colors } = useTheme();
  return <TextInput testID="mobile-subagent-draft" accessibilityLabel={t("task.add_instruction")} multiline value={value}
    editable={!disabled} onChangeText={onChange} placeholder={t("task.add_an_instruction_to_apply_at_a_safe")}
    placeholderTextColor={colors.textMuted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, gap: spacing.sm },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  menuRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: spacing.md },
  heading: { flex: 1, minWidth: 0, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "600" },
  row: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 36, height: 36, borderRadius: radius.md, justifyContent: "center", alignItems: "center" },
  name: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowTitle: { fontSize: 16, lineHeight: 23, fontWeight: "500" },
  secondary: { fontSize: 13, lineHeight: 20 },
  parent: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  parentText: { flexShrink: 1, fontSize: 13 },
  summary: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, marginBottom: spacing.md },
  context: { borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.md },
  informationField: { gap: spacing.xs },
  input: { minHeight: 72, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginVertical: spacing.md, fontSize: 15 },
});
