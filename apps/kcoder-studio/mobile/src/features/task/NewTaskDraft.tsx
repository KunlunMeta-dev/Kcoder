import { ConversationV3Header, ConversationV3WelcomeMark } from "@/features/interface/ConversationV3";
import { TaskMenuSheet, TaskPermissionMenuItem } from "./TaskMenu";
import { DraftAttachmentSelectionSheet, LocalDraftAttachmentPreview } from "./TaskAttachments";
import type { NewTaskDraftAttachments } from "./useNewTaskDraftAttachments";
import { useInterfaceVersion } from "@/storage/interface-version";
import { PermissionModeIcon, PermissionOverrideMarker, TaskPermissionSheet } from "./TaskPermissionSelector";
import type { PermissionMode } from "@/protocol/task-permission-mode";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View, type TextInputInstance } from "react-native";
import { Ban } from "lucide-react-native";
import { t } from "@/i18n";
import { Button } from "@/components/ui";
import { ComposerMetaRow, TaskComposer } from "./TaskComposer";
import { useTaskAppearance } from "./taskStyles";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { composerBottomPadding, useKeyboardVisible } from "@/components/use-keyboard-visible";
import { spacing } from "@/theme";
import { DraftContextBar, type DraftContextActual, type DraftContextRetry, type DraftContextWorkspace, type DraftContextWorkspaceSelection } from "./DraftContextBar";

const noop = () => {};
const noopAsync = async () => {};

/** A local unsent conversation; no runtime or target-side session exists yet. */
export function NewTaskDraft({ cwd, workspaceStatus, targetActionLabel, onTargetAction, targetActionEnabled,
  modeLabel, createsWorktree, input, setInput, ready, busy, locked = false, attachmentUnavailableReason, modelLabel,
  reasoningEffort, bottomInset, modelPickerOpen, modelPickerReady = ready, openModelPicker, submit, children,
  contextActual, contextWorkspaces = [], contextDefaultWorkspacePath, contextWorkspacesReady = false, contextLocked = false,
  contextWorkspacesError, contextRetry,
  permissionMode = "default", permissionsSupported = false, onSelectPermission, draftAttachments,
  onSelectWorkspace, expertSelector, expertSelectorOpen = false, expertSendLocked = false, onBack, onNew, onSettings, onHistory, onProjects, onInbox, draftEditable }: {
  onBack?(): void; onNew?(): void; onSettings?(): void; onHistory?(): void;
  onProjects?(): void; onInbox?(): void; draftEditable?: boolean;
  cwd: string;
  testID?: string;
  workspaceStatus?: string;
  targetActionLabel?: string;
  onTargetAction?: () => void;
  targetActionEnabled?: boolean;
  modeLabel?: string;
  createsWorktree?: boolean;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  ready: boolean;
  busy: boolean;
  locked?: boolean;
  attachmentUnavailableReason?: string;
  modelLabel: string;
  reasoningEffort: string;
  bottomInset: number;
  modelPickerOpen: boolean;
  modelPickerReady?: boolean;
  openModelPicker(): void;
  submit(): Promise<void>;
  children?: React.ReactNode;
  contextActual?: DraftContextActual;
  contextWorkspaces?: DraftContextWorkspace[];
  contextDefaultWorkspacePath?: string;
  contextWorkspacesReady?: boolean;
  contextLocked?: boolean;
  permissionMode?: PermissionMode;
  permissionsSupported?: boolean;
  draftAttachments?: NewTaskDraftAttachments;
  onSelectPermission?(mode: PermissionMode): void;
  contextWorkspacesError?: string | null;
  contextRetry?: DraftContextRetry;
  onSelectWorkspace?(selection: DraftContextWorkspaceSelection): void;
  expertSelector?: React.ReactNode;
  expertSelectorOpen?: boolean;
  expertSendLocked?: boolean;
}) {
  const { styles, colors } = useTaskAppearance();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const v3 = version === "v3";
  const [moreOpen, setMoreOpen] = useState(false);
  const [heroHeight, setHeroHeight] = useState(0);
  const messageInputRef = useRef<TextInputInstance>(null);
  const keyboardVisible = useKeyboardVisible();
  const compactHero = v3 && (keyboardVisible || heroHeight > 0 && heroHeight < 260);
  const [permissionPreviewScope, setPermissionPreviewScope] = useState<object | null>(null);
  const [quickPhrasesOpenRequest, setQuickPhrasesOpenRequest] = useState<object>();
  const currentContextScope = useRef(contextActual?.scopeToken ?? null);
  currentContextScope.current = contextActual?.scopeToken ?? null;
  const currentContextLocked = useRef(busy || contextLocked);
  currentContextLocked.current = busy || contextLocked;
  const permissionPreviewReady = Boolean(ready && !busy && !contextLocked && contextActual?.connectionStatus === "online"
    && contextActual.profileId && contextActual.serverId && contextActual.cwd.trim());
  const permissionPreviewReadyRef = useRef(permissionPreviewReady);
  permissionPreviewReadyRef.current = permissionPreviewReady;
  const permissionPreviewVisible = Boolean(permissionPreviewReady && contextActual && permissionPreviewScope === contextActual.scopeToken);
  useEffect(() => {
    if (!permissionPreviewReady || permissionPreviewScope !== contextActual?.scopeToken) setPermissionPreviewScope(null);
  }, [contextActual?.scopeToken, permissionPreviewScope, permissionPreviewReady]);
  const openPermissionPreview = () => {
    const scopeToken = contextActual?.scopeToken;
    if (!scopeToken || currentContextScope.current !== scopeToken || currentContextLocked.current || !permissionPreviewReadyRef.current) return;
    setPermissionPreviewScope(scopeToken);
  };
  const closePermissionPreview = () => {
    const scopeToken = contextActual?.scopeToken;
    if (!scopeToken || currentContextScope.current !== scopeToken) return;
    setPermissionPreviewScope((current) => current === scopeToken ? null : current);
  };
  const selectWorkspaceForCurrent = (selection: DraftContextWorkspaceSelection) => {
    const scopeToken = contextActual?.scopeToken;
    if (!scopeToken || currentContextScope.current !== scopeToken || currentContextLocked.current) return;
    onSelectWorkspace?.(selection);
  };
  const offline = contextActual?.connectionStatus === "offline" && Boolean(contextActual.serverId);
  return <View testID="new-task-draft" style={[styles.panel, { backgroundColor: v3 ? "transparent" : offline ? colors.surfaceRaised : colors.pageCanvas }]}>
    {v3 ? <ConversationV3Header onBack={onBack ?? noop} onNew={busy ? undefined : onNew}
      navigation={{ projects: onProjects, history: onHistory, inbox: onInbox, settings: onSettings }}
      onMore={() => setMoreOpen(true)} /> : null}
    <View onLayout={event => { if (v3) { const height = Math.round(event.nativeEvent.layout.height); setHeroHeight(previous => previous === height ? previous : height); } }}
      style={[styles.messageListStage, styles.draftHero, v3 && { minHeight: 0, paddingBottom: compactHero ? 0 : Math.min(148, heroHeight ? Math.max(0, heroHeight - 260) : 148) }]}>
      {v3 && !compactHero ? <ConversationV3WelcomeMark /> : null}
      <Text testID="new-task-draft-title" style={[classic ? styles.loadingWorkspaceLabel : styles.draftHeroTitle, v3 && { fontSize: compactHero ? 24 : 32, letterSpacing: 2, color: colors.actionPrimaryText === "#FFFFFF" && colors.background === "#FFFFFF" ? "#2D4B75" : colors.text }]}>{t(!classic && offline ? "v2.server_offline" : "new.draft_title")}</Text>
      <Text testID="new-task-draft-workspace-status" accessibilityLiveRegion="polite" style={classic ? styles.loadingWorkspaceLabel : styles.draftHeroBody}>{v3 ? t(offline ? "v3.offline_draft_hint" : contextActual?.cwd ? "v3.draft_ready_hint" : "v3.choose_project_hint") : !classic && offline ? t("v2.server_offline_body") : workspaceStatus ?? t("new.draft_choose_project")}</Text>
      {(modeLabel || createsWorktree) ? <View testID="new-task-draft-options-summary" style={{ alignItems: "center", gap: 4, marginTop: 10 }}>
        {modeLabel ? <Text style={styles.queueMeta}>{t("new.draft_mode_status", { mode: modeLabel })}</Text> : null}
        {createsWorktree ? <Text style={styles.queueMeta}>{t("new.draft_worktree_status")}</Text> : null}
      </View> : null}
      {targetActionLabel && onTargetAction ? <Button testID="new-task-draft-target-action" variant="secondary" disabled={!targetActionEnabled} onPress={onTargetAction} style={{ marginTop: 12 }}>
        {targetActionLabel}
      </Button> : null}
    </View>
    <View style={[styles.composerWrap, { backgroundColor: v3 ? "transparent" : offline ? colors.surfaceRaised : colors.pageCanvas, paddingBottom: composerBottomPadding(Platform.OS, keyboardVisible, bottomInset, spacing.sm) }]}>
      {children}

      {!classic && !v3 && offline ? <View testID="draft-offline-composer" accessibilityRole="text" style={styles.draftOfflineComposer}><Ban size={18} color={colors.textDim} /><Text style={styles.draftOfflineLabel}>{t("v2.offline_composer_hint")}</Text></View> : null}
      <View style={{ flexDirection: classic || v3 ? "column" : "column-reverse" }}>
      {contextActual ? <DraftContextBar actual={contextActual} workspaces={contextWorkspaces}
        defaultWorkspacePath={contextDefaultWorkspacePath} workspaceOptionsReady={contextWorkspacesReady}
        workspaceOptionsError={contextWorkspacesError} connectionRetry={contextRetry}
        disabled={busy || contextLocked || !onSelectWorkspace} onSelectWorkspace={selectWorkspaceForCurrent} /> : null}
      <View style={!classic && !v3 && offline ? { display: "none" } : undefined}>
      <TaskComposer variant="draft" draftEditable={v3 ? draftEditable : undefined} quickPhrasesOpenRequest={quickPhrasesOpenRequest} toolbar={<ComposerMetaRow
        modelSelector={<Pressable testID="draft-model-selector" hitSlop={v3 ? 6 : undefined} accessibilityRole="button"
          accessibilityLabel={`${t("task.change_model_and_reasoning_effort")} · ${modelLabel}`}
          disabled={!modelPickerReady || busy} onPress={openModelPicker} style={[styles.modelSelectorMeta, !classic && !v3 && !permissionPreviewReady && styles.draftModelSelector]}>
          <Text numberOfLines={1} style={styles.model}>{modelLabel}{reasoningEffort ? ` · ${reasoningEffortLabel(reasoningEffort)}` : ""}</Text>
        </Pressable>}
        expertSelector={expertSelector}
        permissionSelector={permissionPreviewReady && !v3 ? <Pressable testID="draft-permission-selector" accessibilityRole="button"
          accessibilityLabel={t(`task.permission_mode_${permissionMode}`)} accessibilityHint={t("new.draft_permission_first_turn")}
          onPress={openPermissionPreview}
          style={styles.permissionTrigger}>
          <PermissionModeIcon mode={permissionMode} />
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.permissionTriggerLabel}>
            {permissionMode === "default" ? t("v2.permission_default") : t(`task.permission_mode_${permissionMode}`)}
          </Text>
          <PermissionOverrideMarker mode={permissionMode} />
        </Pressable> : null}
        status={busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      />} model={{
        task: null, attachmentSheet: draftAttachments?.sheetOpen ?? false, modelPickerOpen,
        retainedOutbox: { rows: [], error: null, busy: [], available: false,
          resume: noopAsync, checkConsumer: noopAsync, discard: noopAsync },
        snapshot: { threadId: "", title: "", cwd, messages: [], hasMoreBefore: false,
          beforeCursor: null, loadingOlder: false, running: false, connected: ready && !busy && !locked,
          activeTurnId: null, interaction: null, error: null },
        input, setInput, attachments: [], removeAttachment: noopAsync, messageInputRef,
        setQueueError: noop, setComposerNotice: noop, openAttachmentSheet: noop, submit,
        canSend: ready && !busy && !draftAttachments?.busy && Boolean(input.trim() || draftAttachments?.items.length), failedSubmissions: [],
        retryFailedSubmission: noopAsync, checkFailedSubmission: noopAsync,
        dismissFailedSubmission: noop, removeFailedSubmissionAttachment: noop,
      }} sendLocked={expertSendLocked} externalOverlayOpen={modelPickerOpen || permissionPreviewVisible || expertSelectorOpen} localAttachments={draftAttachments ? {
        count: draftAttachments.items.length, disabled: !ready || busy || locked || draftAttachments.busy || draftAttachments.locked || !draftAttachments.available,
        open: draftAttachments.open, preview: draftAttachments.items.length ? <LocalDraftAttachmentPreview items={draftAttachments.items}
          disabled={busy || locked || draftAttachments.locked || !draftAttachments.available} onRemove={id => void draftAttachments.remove(id)} /> : undefined,
      } : undefined} />
      </View>
      </View>
      {draftAttachments && !draftAttachments.available && ready ? <Text testID="draft-attachment-unavailable" style={styles.queueMeta}>{attachmentUnavailableReason ?? t("new.draft_attachments_unavailable")}</Text> : null}
      {draftAttachments?.error && !draftAttachments.sheetOpen ? <Text testID="draft-attachment-error" accessibilityRole="alert" style={styles.queueMeta}>{draftAttachments.error}</Text> : null}
      {draftAttachments ? <DraftAttachmentSelectionSheet model={draftAttachments} bottomInset={bottomInset}
        onQuickPhrases={permissionPreviewReady ? () => { draftAttachments.close(); setQuickPhrasesOpenRequest({}); } : undefined} /> : null}

      {v3 ? <TaskMenuSheet visible={moreOpen} title={t("task.more")} testID="v3-draft-more" onClose={() => setMoreOpen(false)}>
        <TaskPermissionMenuItem disabled={!permissionPreviewReady} permissionLabel={t(`task.permission_mode_${permissionMode}`)}
          onPress={() => { setMoreOpen(false); openPermissionPreview(); }} />
        {onHistory ? <Pressable testID="v3-draft-history" accessibilityRole="button" onPress={() => { setMoreOpen(false); onHistory(); }} style={styles.taskMenuRow}><Text style={styles.taskMenuText}>{t("v2.history")}</Text></Pressable> : null}
        {onSettings ? <Pressable testID="v3-draft-settings" accessibilityRole="button" onPress={() => { setMoreOpen(false); onSettings(); }} style={styles.taskMenuRow}><Text style={styles.taskMenuText}>{t("common.settings")}</Text></Pressable> : null}
      </TaskMenuSheet> : null}
      <TaskPermissionSheet visible={permissionPreviewVisible} supported={permissionsSupported} selected={permissionMode}
        subtitle={t("new.draft_permission_first_turn")} canChange={permissionPreviewReady && Boolean(onSelectPermission)} error={null} onClose={closePermissionPreview}
        onSelect={mode => { if (currentContextScope.current !== contextActual?.scopeToken || currentContextLocked.current || !permissionPreviewReadyRef.current) return; onSelectPermission?.(mode); closePermissionPreview(); }} />
    </View>
  </View>;
}
