import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions, type FlatListInstance, type TextInputInstance } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { t } from "@/i18n";
import { spacing, useTheme } from "@/theme";
import { composerBottomPadding, useKeyboardVisible } from "@/components/use-keyboard-visible";
import { initialMessageFollowState } from "@/components/message-follow-state";
import type { AgentSummary, ChatMessage } from "@/runtime/task-runtime/types";
import type { AgentPage } from "@/runtime/task-runtime/agents";
import type { AgentConversationView } from "@/runtime/task-runtime/agent-conversation";
import { ComposerField } from "./TaskComposer";
import { useComposerInputLayout } from "./useComposerInputLayout";
import { TaskTranscript, JumpToLatestButton, type TranscriptDisplayModel } from "./TaskTranscript";
import { handleTranscriptLayoutChange } from "./useTaskHistory";
import { ComposerFloatingLayer, ComposerFloatingAnchor } from "./ComposerFloatingLayer";
import { useTaskAppearance } from "./taskStyles";
import { subagentStatusLabel } from "./TaskSubagentView";

export interface SubagentComposerProps {
  value: string; onChange(value: string): void; disabled: boolean; canSend: boolean;
  onSend(): void; label: string; running: boolean; bottomInset: number;
  stopAction?: { label: string; disabled: boolean; onPress(): void };
}

export function TaskSubagentComposer({ value, onChange, disabled, canSend, onSend, label, running, bottomInset, stopAction, aboveComposer }: SubagentComposerProps & { aboveComposer?: ReactNode }) {
  const { styles } = useTaskAppearance();
  const keyboardVisible = useKeyboardVisible();
  const inputRef = useRef<TextInputInstance>(null);
  const { layoutState, composerLayout, updateLayout, preserveExpandedRef, beginControlPress, endControlPress } = useComposerInputLayout({
    input: value, attachmentCount: 0, messageInputRef: inputRef, overlayOpen: false, compactDraftWhenUnfocused: true,
  });
  return <View testID="mobile-subagent-composer" style={[styles.composerWrap, {
    paddingBottom: composerBottomPadding(Platform.OS, keyboardVisible, bottomInset, spacing.sm),
  }]}>
    <ComposerFloatingAnchor floating controls={aboveComposer ? <View style={{ pointerEvents: "box-none" }}
      onPointerDown={Platform.OS === "web" ? beginControlPress : undefined} onPointerUp={Platform.OS === "web" ? endControlPress : undefined}
      onPointerCancel={Platform.OS === "web" ? endControlPress : undefined}
      onTouchStart={beginControlPress} onTouchEnd={endControlPress} onTouchCancel={endControlPress}>{aboveComposer}</View> : null}>
      <ComposerField draft={value} inputRef={inputRef} inputTestID="mobile-subagent-draft" inputEditable={!disabled}
        layoutState={layoutState} layout={composerLayout} placeholder={t("task.add_an_instruction_to_apply_at_a_safe")}
        canSend={canSend} sendLabel={label} sendText={label} sendTestID="mobile-subagent-send" running={running}
        showAttachment={false} attachmentDisabled stopAction={stopAction} maxLength={64 * 1024}
        onInputFocus={() => updateLayout({ type: "focus" })} onInputPressIn={() => updateLayout({ type: "focus" })}
        onInputBlur={() => { if (!preserveExpandedRef.current) updateLayout({ type: "blur" }); }}
        onRootBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !preserveExpandedRef.current) updateLayout({ type: "blur" }); }}
        onContentSizeChange={height => updateLayout({ type: "content-size-changed", height })}
        onChangeText={text => { updateLayout({ type: "focus" }); onChange(text); }} onSubmit={onSend} />
    </ComposerFloatingAnchor>
  </View>;
}

/** Same transcript, follow/scroll behavior and input surface as the main conversation. */
export function TaskSubagentConversation({ agent, view, page, parentTitle, targetLabel, directory, onParent, controls, composer, history = false }: {
  agent: AgentSummary; view?: AgentConversationView; page: AgentPage | null;
  parentTitle: string; targetLabel: string; directory: string; onParent(): void;
  controls?: ReactNode; composer?: SubagentComposerProps; history?: boolean;
}) {
  const { styles } = useTaskAppearance();
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const owner = useRef({ agentId: agent.agentId }).current;
  const messageListRef = useRef<FlatListInstance>(null), messageListLayoutHeight = useRef(0);
  const messageFollowState = useRef(initialMessageFollowState());
  const mountedRef = useRef(true), mountGeneration = useRef(0), ownerRef = useRef<object | undefined>(owner);
  const webPrependAnchor = useRef<TranscriptDisplayModel["webPrependAnchor"]["current"]>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; mountGeneration.current++; }; }, []);
  const snapshot = view?.snapshot;
  const model: TranscriptDisplayModel = { displayOwner: owner, cwd: directory,
    snapshot: { messages: snapshot?.messages ?? (page?.content ? [{ id: `agent-public-${agent.agentId}`, role: "assistant", content: page.content, timestampMs: 0 }] : []),
      connected: Boolean(snapshot?.connected && !view?.error && !view?.loading), running: Boolean(snapshot?.running && !view?.error && !view?.loading),
      activeTurnId: snapshot?.activeTurnId ?? null, hasMoreBefore: false, loadingOlder: false, error: null },
    messageListRef, messageFollowState, mountedRef, mountGeneration, webPrependAnchor, setShowJumpToLatest,
    compensateWebPrepend: () => false, loadOlder: async () => {}, onOpenFile: () => false, onOpenChanges: () => {} };
  return <ComposerFloatingLayer style={{ flex: 1 }}>
    <View testID="mobile-subagent-conversation" style={{ paddingHorizontal: spacing.md }}>
      <Pressable testID="mobile-subagent-parent" accessibilityRole="button" onPress={onParent}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <ArrowLeft size={15} color={colors.textMuted} /><Text numberOfLines={1} style={{ color: colors.textMuted, flexShrink: 1, fontSize: 13 }}>{t("inbox.subagent_parent", { p0: parentTitle })}</Text>
      </Pressable>
      <Text style={{ color: colors.textMuted, fontSize: 13 }}>{history ? t("task.history") : subagentStatusLabel(agent.status)} · {targetLabel}</Text>
      {view?.loading ? <ActivityIndicator color={colors.textMuted} /> : null}
      {view?.error ? <Text testID="subagent-stream-error" accessibilityRole="alert" style={{ color: colors.textMuted, fontSize: 13 }}>{t("task.subagent_stream_reconnecting")}</Text> : null}
      {view?.truncated ? <Text testID="subagent-stream-window" style={{ color: colors.textMuted, fontSize: 13 }}>{t("task.subagent_stream_window")}</Text> : null}
    </View>
    <View style={styles.messageListStage} onLayout={event => handleTranscriptLayoutChange({
      messageListRef, messageListLayoutHeight, messageFollowState, setShowJumpToLatest, mountedRef, mountGeneration, ownerRef,
    }, event)}>
      <TaskTranscript model={model} readOnly connectionNoticeOwned />
      {!composer && showJumpToLatest ? <JumpToLatestButton model={model} /> : null}
    </View>
    {controls ? <ScrollView style={{ maxHeight: Math.max(140, Math.min(320, height * 0.4)), flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: spacing.md }} keyboardShouldPersistTaps="handled">{controls}</ScrollView> : null}
    {composer ? <TaskSubagentComposer {...composer} aboveComposer={showJumpToLatest ? <JumpToLatestButton model={model} inComposer /> : null} /> : null}
  </ComposerFloatingLayer>;
}
