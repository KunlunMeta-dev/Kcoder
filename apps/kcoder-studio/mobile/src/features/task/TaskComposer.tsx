import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { MAX_TASK_MESSAGE_CHARACTERS } from "@/protocol/task-message-limits";
import { ArrowUp, Send, Paperclip, Plus, Sparkles, Square, X } from "lucide-react-native";
import { useInterfaceVersion } from "@/storage/interface-version";
import { PermissionModeIcon } from "./TaskPermissionSelector";
import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type ReactNode, type Ref } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputInstance,
} from "react-native";
import {
  ComposerAttachmentPreview,
  StagedAttachmentChip,
} from "./TaskAttachments";
import {
  COMPOSER_INPUT_LINE_HEIGHT,
  reduceComposerLayoutState,
  resolveComposerLayout,
  type ComposerLayoutState,
} from "./taskComposerLayout";
import { useTaskAppearance } from "./taskStyles";
import { appendQuickPhraseToDraft } from "./quick-phrase-composer";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";
import { composerBottomPadding, useKeyboardVisible } from "@/components/use-keyboard-visible";
import { spacing } from "@/theme";
import { v3ConversationPalette } from "@/features/interface/v3-styles";
import { ComposerFloatingAnchor } from "./ComposerFloatingLayer";
import { useComposerInputLayout } from "./useComposerInputLayout";

type ComposerModel = Pick<ReturnType<typeof useTaskModelPreferences>,
  "attachmentSheet" | "modelPickerOpen" | "snapshot" | "input" |
  "setInput" | "attachments" | "removeAttachment" | "messageInputRef" | "setQueueError" |
  "setComposerNotice" | "openAttachmentSheet" | "submit" | "canSend" | "failedSubmissions" |
  "retryFailedSubmission" | "checkFailedSubmission" | "dismissFailedSubmission" |
  "removeFailedSubmissionAttachment"> & {
    task: ReturnType<typeof useTaskModelPreferences>["task"] | null;
    retainedOutbox: Pick<ReturnType<typeof useTaskModelPreferences>["retainedOutbox"],
      "rows" | "error" | "busy" | "available" | "resume" | "checkConsumer" | "discard">;
  };

function estimateComposerContentHeight(draft: string) {
  return Math.max(COMPOSER_INPUT_LINE_HEIGHT, draft.split(/\r?\n/).length * COMPOSER_INPUT_LINE_HEIGHT);
}

type ComposerFieldProps = {
  variant?: "conversation" | "draft";
  toolbar?: ReactNode;
  draft: string;
  layoutState: ComposerLayoutState;
  layout: ReturnType<typeof resolveComposerLayout>;
  inputRef?: Ref<TextInputInstance>;
  inputEditable: boolean;
  inputAccessibilityHint?: string;
  placeholder: string;
  running?: boolean;
  canSend: boolean;
  sendLabel: string;
  sendTestID: string;
  inputTestID?: string;
  sendText?: string;
  showAttachment: boolean;
  attachmentDisabled: boolean;
  showQuickPhrases?: boolean;
  stopAction?: { label: string; disabled: boolean; onPress(): void };
  attachmentPreview?: ReactNode;
  maxLength?: number;
  onInputFocus?(): void;
  onInputBlur?(): void;
  onInputPressIn?(): void;
  onContentSizeChange?(height: number): void;
  onChangeText?(value: string): void;
  onAttachmentPressIn?(): void;
  onAttachmentPressOut?(): void;
  onAttachmentPress?(): void;
  onQuickPhrasesPress?(): void;
  onSubmit?(): void;
  onRootBlur?(event: FocusEvent<HTMLElement>): void;
};

/** Pure conversation input presentation shared by live and cached sessions. */
export function ComposerField({
  variant = "conversation", toolbar, draft, layoutState, layout, inputRef, inputEditable, inputAccessibilityHint,
  placeholder, running = false, canSend, sendLabel, sendTestID, showAttachment,
  attachmentDisabled, showQuickPhrases = false, stopAction, attachmentPreview,
  maxLength, inputTestID, sendText, onInputFocus, onInputBlur, onInputPressIn, onContentSizeChange,
  onChangeText, onAttachmentPressIn, onAttachmentPressOut, onAttachmentPress,
  onQuickPhrasesPress, onSubmit, onRootBlur,
}: ComposerFieldProps) {
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const v3 = version === "v3";
  const { styles, colors } = useTaskAppearance();
  const expanded = layout.expanded;
  const sendDisabled = !canSend;
  return (
    <>
    <View
      testID="message-input-root"
      style={[styles.composer, variant === "draft" && styles.draftComposer, layoutState.focused && styles.composerFocused]}
      onBlur={Platform.OS === "web" ? (event) => {
        const focusEvent = event as unknown as FocusEvent<HTMLElement>;
        onRootBlur?.(focusEvent);
      } : undefined}
    >
      {attachmentPreview}
      <View
        testID="message-input-area"
        style={[
          styles.composerInputArea,
          expanded && styles.composerInputAreaExpanded,
          expanded ? { height: classic ? layout.inputHeight + 64 : Math.max(v3 ? 48 : 60, layout.inputHeight + 24) } : undefined,
        ]}
      >
        <TextInput
          ref={inputRef}
          testID={inputTestID ?? "message-input"}
          accessibilityLabel={t("task.send_a_message")}
          accessibilityHint={inputAccessibilityHint}
          accessibilityState={{ disabled: !inputEditable }}
          value={draft}
          onFocus={onInputFocus}
          onBlur={Platform.OS === "web" ? undefined : onInputBlur}
          onPressIn={onInputPressIn}
          onPointerDown={Platform.OS === "web" ? onInputPressIn : undefined}
          onContentSizeChange={({ nativeEvent }) => onContentSizeChange?.(nativeEvent.contentSize.height)}
          onChangeText={onChangeText}
          maxLength={maxLength}
          multiline
          scrollEnabled={expanded && layout.scrollEnabled}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          style={[
            styles.composerInput,
            expanded ? styles.composerInputExpanded : styles.composerInputCollapsed,
            Platform.OS === "web" ? { outlineStyle: "solid", outlineWidth: 0 } : undefined,
            !expanded && Platform.OS === "web"
              ? { paddingVertical: (44 - COMPOSER_INPUT_LINE_HEIGHT) / 2 }
              : undefined,
            !expanded && running ? styles.composerInputCollapsedRunning : undefined,
            expanded ? { height: layout.inputHeight } : undefined,
            expanded && layout.scrollEnabled ? styles.composerInputScrollable : undefined,
          ]}
          editable={inputEditable}
        />
      </View>
        <View
          testID="composer-toolbar"
          style={[styles.composerActions, classic ? (expanded ? styles.composerActionsExpanded : styles.composerActionsCollapsed) : variant === "conversation" && styles.conversationComposerActions, { pointerEvents: "box-none" }]}
        >
          {showAttachment ? (
            <Pressable
              testID="composer-attachment"
              hitSlop={v3 ? 10 : undefined}
              accessibilityRole="button"
              accessibilityLabel={t("task.add_attachment")}
              accessibilityState={{ disabled: attachmentDisabled }}
              disabled={attachmentDisabled}
              onPressIn={onAttachmentPressIn}
              onPressOut={onAttachmentPressOut}
              onPress={onAttachmentPress}
              style={[styles.attachButton, variant === "draft" && styles.draftAttachButton, attachmentDisabled && styles.sendDisabled]}
            >
              {classic ? <Paperclip size={22} color={attachmentDisabled ? colors.textDim : colors.textMuted} /> : <Plus size={v3 ? 18 : 22} color={attachmentDisabled ? colors.textDim : v3 ? v3ConversationPalette(colors).userText : colors.textMuted} />}
            </Pressable>
          ) : null}
          {showQuickPhrases && expanded ? (
            <Pressable
              testID="composer-quick-phrases"
              accessibilityRole="button"
              accessibilityLabel={t("settings_personalization.open_quick_phrases")}
              accessibilityState={{ disabled: !inputEditable }}
              disabled={!inputEditable}
              onPressIn={onAttachmentPressIn}
              onPressOut={onAttachmentPressOut}
              onPress={onQuickPhrasesPress}
              style={[styles.attachButton, !inputEditable && styles.sendDisabled]}
            >
              <Sparkles size={20} color={!inputEditable ? colors.textDim : colors.textMuted} />
            </Pressable>
          ) : null}
          {!classic ? toolbar : null}
          {toolbar && !classic ? null : <View style={[styles.composerActionSpacer, { pointerEvents: "none" }]} />}
          {stopAction ? (
            <Pressable
              testID="stop-turn"
              accessibilityRole="button"
              accessibilityLabel={stopAction.label}
              accessibilityState={{ disabled: stopAction.disabled }}
              disabled={stopAction.disabled}
              onPress={stopAction.onPress}
              style={[styles.stopButton, stopAction.disabled && styles.sendDisabled]}
            >
              {stopAction.disabled ? <ActivityIndicator size="small" color={colors.textDim} /> : <Square size={14} fill={colors.text} color={colors.text} />}
            </Pressable>
          ) : null}
          <Pressable
            testID={sendTestID}
            hitSlop={v3 ? 6 : undefined}
            accessibilityRole="button"
            accessibilityLabel={sendLabel}
            accessibilityState={{ disabled: sendDisabled }}
            disabled={sendDisabled}
            onPress={onSubmit}
            style={[styles.sendButton, sendDisabled && (!classic && variant === "conversation" ? styles.conversationSendButtonDisabled : styles.sendButtonDisabled)]}
          >
            {v3 ? <><Send size={15} color="#FFFFFF" /><Text style={{ color: "#FFFFFF", fontSize: 13 }}>{sendText ?? (running ? t("v3.queue") : t("task.send"))}</Text></>
              : <ArrowUp size={20} color={sendDisabled && (classic || variant === "conversation") ? colors.textDim : colors.actionPrimaryText} />}
          </Pressable>
        </View>
    </View>
    {classic ? toolbar : null}
    </>
  );
}

export function ComposerMetaRow({ modelSelector, permissionSelector, expertSelector, status }: {
  modelSelector: ReactNode; permissionSelector: ReactNode; expertSelector?: ReactNode; status: ReactNode;
}) {
  const { styles } = useTaskAppearance();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const v3 = version === "v3";
  return <View style={styles.composerMeta}>{classic ? modelSelector : null}{permissionSelector}{!classic ? modelSelector : null}{expertSelector}{status}</View>;
}

/** Same conversation presentation while cache recovery has no writable runtime. */
export function CachedTaskComposer({ draft, bottomInset, offline, aboveComposer }: {
  draft: string; bottomInset: number; offline: boolean; aboveComposer?: ReactNode;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const useCachedV3 = useInterfaceVersion() === "v3";
  const [layoutState, setLayoutState] = useState(() => ({ focused: false, contentHeight: estimateComposerContentHeight(draft) }));
  const measuredDraft = useRef(draft);
  const draftChanged = measuredDraft.current !== draft;
  const presentationLayoutState = draftChanged
    ? { ...layoutState, contentHeight: estimateComposerContentHeight(draft) }
    : layoutState;
  useEffect(() => {
    if (measuredDraft.current === draft) return;
    measuredDraft.current = draft;
    setLayoutState((previous) => ({ ...previous, contentHeight: estimateComposerContentHeight(draft) }));
  }, [draft]);
  const layout = resolveComposerLayout(presentationLayoutState, { draft, attachmentCount: 0 });
  const disabledState = { disabled: true };
  return (
    <View testID="cached-session-composer" style={[styles.composerWrap, { paddingBottom: composerBottomPadding(Platform.OS, false, bottomInset, spacing.sm) }]}>
      <ComposerRecoveryFrame floating={useCachedV3} recovery={null} accessory={aboveComposer}>
      <ComposerField
        toolbar={<ComposerMetaRow
        modelSelector={<Pressable testID="cached-session-model-selector" accessibilityRole="button"
          accessibilityLabel={t("task.cache_model_unavailable")} accessibilityState={disabledState} disabled
          style={styles.modelSelectorMeta}>
          <Text testID="cached-session-model-label" numberOfLines={1}
            style={[styles.model, { color: colors.textDim }]}>{t("task.cache_model_label")}</Text>
        </Pressable>}
        permissionSelector={<Pressable testID="cached-session-permission-selector" accessibilityRole="button"
          accessibilityLabel={t("task.cache_permissions_unavailable")} accessibilityState={disabledState} disabled
          style={[styles.permissionTrigger, useCachedV3 && { display: "none" }]}>
          <PermissionModeIcon mode="default" disabled />
          <Text testID="cached-session-permission-label" numberOfLines={1} ellipsizeMode="tail"
            style={[styles.permissionTriggerLabel, { color: colors.textDim }]}>
            {t("task.cache_permissions_label")}
          </Text>
        </Pressable>}
        status={<Text testID="cached-session-connection-label" numberOfLines={1} style={styles.connection}>
          {offline ? t("task.offline") : t("task.cache_connecting_label")}
        </Text>}
      />}
        draft={draft}
        layoutState={presentationLayoutState}
        layout={layout}
        inputEditable={false}
        inputAccessibilityHint={t("task.cache_compose_unavailable")}
        placeholder={t("task.cache_compose_unavailable")}
        canSend={false}
        sendLabel={t("task.send")}
        sendTestID="send-message"
        showAttachment
        attachmentDisabled
        showQuickPhrases={false}
        onContentSizeChange={(height) => setLayoutState((previous) => reduceComposerLayoutState(previous, { type: "content-size-changed", height }))}
      />
      </ComposerRecoveryFrame>
    </View>
  );
}

function ComposerRecoveryFrame({ floating, recovery, accessory, children, onControlsPressIn, onControlsPressOut }: {
  floating: boolean;
  recovery: ReactNode;
  accessory?: ReactNode;
  children: ReactNode;
  onControlsPressIn?(): void;
  onControlsPressOut?(): void;
}) {
  const { styles } = useTaskAppearance();
  const { height } = useWindowDimensions();
  const keyboardVisible = useKeyboardVisible();
  const visibleHeight = Math.min(height, keyboardVisible ? Keyboard.metrics?.()?.screenY ?? height : height);
  const maxHeight = Math.max(80, Math.min(240, visibleHeight * 0.3) - (accessory ? 44 : 0));
  return <ComposerFloatingAnchor floating={floating} controls={floating && (accessory || recovery) ? <View style={{ gap: spacing.sm, pointerEvents: "box-none" }}
    onPointerDown={Platform.OS === "web" ? onControlsPressIn : undefined}
    onPointerUp={Platform.OS === "web" ? onControlsPressOut : undefined}
    onPointerCancel={Platform.OS === "web" ? onControlsPressOut : undefined}
    onTouchStart={onControlsPressIn} onTouchEnd={onControlsPressOut} onTouchCancel={onControlsPressOut}>
      {accessory}
      {recovery ? <ScrollView
        testID="submission-recovery-overlay"
        style={[styles.submissionRecoveryOverlay, { maxHeight }]}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >{recovery}</ScrollView> : null}
    </View> : null}>
    {!floating ? recovery : null}
    {children}
  </ComposerFloatingAnchor>;
}

export function TaskComposer({
  variant = "conversation",
  model,
  sendLocked = false,
  sendLockRef,
  externalOverlayOpen = false,
  quickPhrasesOpenRequest,
  localAttachments,
  toolbar,
  aboveComposer,
  draftEditable,
}: {
  variant?: "conversation" | "draft";
  toolbar?: ReactNode;
  aboveComposer?: ReactNode;
  draftEditable?: boolean;
  model: ComposerModel;
  sendLocked?: boolean;
  sendLockRef?: { readonly current: boolean };
  externalOverlayOpen?: boolean;
  quickPhrasesOpenRequest?: object;
  localAttachments?: { count: number; disabled: boolean; preview: ReactNode; open(): void };
}) {
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { styles, colors } = useTaskAppearance();
  const appPreferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const {
    task,
    attachmentSheet,
    modelPickerOpen,
    retainedOutbox,
    snapshot,
    input,
    setInput,
    attachments,
    removeAttachment,
    messageInputRef,
    setQueueError,
    setComposerNotice,
    openAttachmentSheet,
    submit,
    canSend,
    failedSubmissions,
    retryFailedSubmission,
    checkFailedSubmission,
    dismissFailedSubmission,
    removeFailedSubmissionAttachment,
  } = model;
  const currentSendLocked = sendLocked || Boolean(sendLockRef?.current);
  // Keep routine persistence silent while retaining actionable recovery states.
  const visibleSubmissions = v3
    ? failedSubmissions.filter((submission) => !submission.retrying || Boolean(
      submission.acceptedTurn && submission.acceptedTurn.threadId === snapshot.threadId,
    ))
    : failedSubmissions;
  const [quickPhrasesOpen, setQuickPhrasesOpen] = useState(false);
  const handledQuickPhrasesRequest = useRef<object | undefined>(undefined);
  const quickPhrasesAvailable = snapshot.connected && snapshot.configurationReady !== false && !snapshot.archivedAt;
  useEffect(() => {
    if (!quickPhrasesAvailable) setQuickPhrasesOpen(false);
    if (!quickPhrasesOpenRequest || handledQuickPhrasesRequest.current === quickPhrasesOpenRequest) return;
    // Consume the request even offline so reconnect cannot replay an old menu action.
    handledQuickPhrasesRequest.current = quickPhrasesOpenRequest;
    if (quickPhrasesAvailable) setQuickPhrasesOpen(true);
  }, [quickPhrasesOpenRequest, quickPhrasesAvailable]);
  const { layoutState, composerLayout, updateLayout, preserveExpandedRef, beginControlPress, endControlPress } = useComposerInputLayout({
    input, attachmentCount: attachments.length + (localAttachments?.count ?? 0), messageInputRef,
    overlayOpen: externalOverlayOpen || attachmentSheet || modelPickerOpen || quickPhrasesOpen,
    compactDraftWhenUnfocused: v3,
  });

  const insertQuickPhrase = (content: string) => {
    const next = appendQuickPhraseToDraft(input, content);
    setInput(next);
    setQueueError(null);
    setComposerNotice(null);
    setQuickPhrasesOpen(false);
    requestAnimationFrame(() => messageInputRef.current?.focus());
  };

  return (
    <>
      {snapshot.stopRequestedTurnId ? (
        <Text
          testID="stop-turn-status"
          accessibilityRole="alert"
          style={styles.queueMeta}
        >
          {snapshot.stopAcceptanceUnknown
            ? t("task.stop_result_unknown")
            : t("task.stopping_waiting_for_turn")}
        </Text>
      ) : null}
      {retainedOutbox.rows.length > 0 || retainedOutbox.error ? (
        <View testID="retained-attachment-outbox" style={styles.failedDraftList}>
          {retainedOutbox.rows.map(row => {
            const busy = retainedOutbox.busy.includes(row.id) || retainedOutbox.busy.includes("prepare");
            const hasConsumer = row.consumers.length > 0;
            return <View key={row.id} testID="retained-attachment-row" style={styles.failedDraftCard}>
              <Text style={styles.failedDraftTitle}>{row.filename}</Text>
              <Text style={styles.queueMeta}>{hasConsumer ? "消息附件待核对；原文件保留" : row.phase === "sealed" ? "上传已确认；尚未加入消息" : "原文件已保存在此设备，等待继续处理"}</Text>
              {!retainedOutbox.available ? <Text style={styles.queueMeta}>当前连接暂不支持继续处理，原文件保留</Text> : null}
              <View style={styles.failedDraftActions}>
                <Pressable testID={hasConsumer ? "check-retained-attachment" : "resume-retained-attachment"}
                  accessibilityRole="button" accessibilityLabel={`${hasConsumer ? "核对附件" : "继续上传"} ${row.filename}`}
                  disabled={busy || !retainedOutbox.available || (!hasConsumer && row.phase === "sealed")}
                  onPress={() => { void (hasConsumer ? retainedOutbox.checkConsumer(row.id) : retainedOutbox.resume(row.id)).catch(() => {}); }}>
                  <Text style={styles.failedDraftRetryText}>{busy ? "正在核对…" : hasConsumer ? "核对状态" : "继续上传"}</Text>
                </Pressable>
                {!hasConsumer ? <Pressable testID="discard-retained-attachment" accessibilityRole="button" accessibilityLabel={`移除附件 ${row.filename}`}
                  disabled={busy || (!retainedOutbox.available && Boolean(row.wire || row.scopeId))}
                  onPress={() => { void retainedOutbox.discard(row.id).catch(() => {}); }}>
                  <Text style={styles.failedDraftRetryText}>移除</Text>
                </Pressable> : null}
              </View>
            </View>;
          })}
          {retainedOutbox.error ? <Text testID="retained-attachment-error" accessibilityRole="alert" style={styles.failedDraftError}>{retainedOutbox.error}</Text> : null}
        </View>
      ) : null}
      <ComposerRecoveryFrame floating={v3} accessory={aboveComposer} onControlsPressIn={beginControlPress} onControlsPressOut={endControlPress} recovery={task && visibleSubmissions.length > 0 ? (
        <View testID="failed-submissions" style={styles.failedDraftList}>
          {visibleSubmissions.map((submission, index) => {
            const isUnknown = submission.outcome === "unknown";
            const isAccepted = isUnknown && Boolean(submission.acceptedTurn && submission.acceptedTurn.threadId === snapshot.threadId);
            const isPending = submission.retrying;
            const recoveryColor = isPending || isAccepted
              ? colors.textMuted
              : isUnknown ? colors.yellow : colors.red;
            const retryDisabled =
              isPending ||
              !snapshot.connected ||
              snapshot.running ||
              Boolean(snapshot.interaction) ||
              Boolean(snapshot.archivedAt) ||
              (!isUnknown && snapshot.sendAcceptanceUnknown);
            const checkDisabled =
              isPending || !snapshot.connected || snapshot.acceptanceChecking;
            const dismissDisabled = submission.retrying;
            return (
              <View
                key={submission.id}
                testID="failed-submission"
                style={[styles.failedDraftCard, !isPending && !isAccepted && { borderColor: recoveryColor }]}
              >
                <View style={styles.failedDraftHeader}>
                  <View style={styles.failedDraftCopy}>
                    <Text testID="submission-recovery-title" style={[styles.failedDraftTitle, { color: recoveryColor }]}>
                      {isAccepted
                        ? t("task.accepted_submission_syncing")
                        : isPending
                        ? submission.phase === "preparing"
                          ? t("task.failed_submission_preparing")
                          : submission.phase === "retaining"
                            ? t(submission.attachments.length > 0
                              ? "task.failed_submission_retaining"
                              : "task.failed_submission_preparing_message")
                            : t("task.failed_submission_sending")
                        : isUnknown
                          ? t("task.failed_submission_unknown")
                          : t("task.failed_submission_failed_saved")}
                    </Text>
                    <Text
                      testID="failed-submission-content"
                      numberOfLines={3}
                      style={styles.failedDraftContent}
                    >
                      {submission.content ||
                        t("task.attachments", {
                          p0: submission.attachments.length,
                        })}
                    </Text>
                    <Text style={styles.queueMeta}>
                      {submission.attachments.length > 0
                        ? t("task.attachments", {
                            p0: submission.attachments.length,
                          })
                        : t("task.message")}
                      {isAccepted
                        ? t("task.accepted_submission_check_only")
                        : isPending
                        ? t("task.wait_for_send_result")
                        : isUnknown
                          ? t("task.no_retry_until_check")
                          : t("task.manual_retry_available")}
                    </Text>
                    {submission.error ? (
                      <Text
                        testID="failed-submission-error"
                        accessibilityRole="alert"
                        style={styles.failedDraftError}
                      >
                        {submission.error}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.failedDraftActions}>
                    <Pressable
                      testID={
                        isUnknown
                          ? "verify-failed-submission"
                          : "retry-failed-submission"
                      }
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        isAccepted
                          ? "task.sync_message_record_for_item"
                          : isUnknown
                          ? "task.check_send_status_for_item"
                          : "task.retry_failed_message",
                        { p0: index + 1 },
                      )}
                      disabled={isUnknown ? checkDisabled : retryDisabled}
                      accessibilityState={{
                        disabled: isUnknown ? checkDisabled : retryDisabled,
                        busy: submission.retrying,
                      }}
                      onPress={() =>
                        void (isUnknown
                          ? checkFailedSubmission(submission.id)
                          : retryFailedSubmission(submission.id))
                      }
                      style={[
                        styles.failedDraftRetry,
                        (isUnknown ? checkDisabled : retryDisabled) &&
                          styles.sendDisabled,
                      ]}
                    >
                      {submission.retrying ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.accentText}
                        />
                      ) : (
                        <Text style={styles.failedDraftRetryText}>
                          {isAccepted
                            ? t("task.sync_message_record_short")
                            : isUnknown
                            ? t("task.check_send_status_short")
                            : t("task.retry")}
                        </Text>
                      )}
                    </Pressable>
                    <Pressable
                      testID="dismiss-failed-submission"
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        isAccepted
                          ? "task.remove_accepted_message_notice"
                          : isUnknown
                          ? "task.remove_unverified_send_notice"
                          : "task.remove_failed_submission_draft",
                        { p0: index + 1 },
                      )}
                      disabled={dismissDisabled}
                      accessibilityState={{ disabled: dismissDisabled }}
                      onPress={() => dismissFailedSubmission(submission.id)}
                      style={[
                        styles.failedDraftDismiss,
                        dismissDisabled && styles.sendDisabled,
                      ]}
                    >
                      <X size={16} color={colors.textMuted} />
                    </Pressable>
                  </View>
                </View>
                {submission.attachments.length > 0 ? (
                  <ScrollView
                    testID="failed-submission-attachments"
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.failedDraftAttachmentList}
                  >
                    {submission.attachments.map((attachment) => (
                      <StagedAttachmentChip
                        key={attachment.path}
                        attachment={attachment}
                        task={task}
                        removeDisabled={isUnknown || submission.retrying}
                        onRemove={() =>
                          removeFailedSubmissionAttachment(
                            submission.id,
                            attachment.path,
                          )
                        }
                      />
                    ))}
                  </ScrollView>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}>
      <ComposerField
        variant={variant}
        toolbar={toolbar}
        draft={input}
        layoutState={layoutState}
        layout={composerLayout}
        inputRef={messageInputRef}
        inputEditable={variant === "draft" ? draftEditable ?? snapshot.connected : snapshot.connected}
        placeholder={snapshot.running ? t("task.type_a_message_to_queue") : t("task.send_a_message")}
        running={snapshot.running}
        canSend={canSend && !currentSendLocked}
        sendLabel={snapshot.running ? t("task.queue_message") : t("task.send")}
        sendTestID={snapshot.running ? "queue-message" : "send-message"}
        showAttachment={Boolean(task) || Boolean(localAttachments)}
        attachmentDisabled={!snapshot.connected || Boolean(localAttachments?.disabled)}
        showQuickPhrases={appPreferences.interfaceVersion === "classic" && quickPhrasesAvailable}
        stopAction={task && snapshot.running ? {
          label: snapshot.stopRequestedTurnId === snapshot.activeTurnId ? t("task.stopping") : t("task.stop"),
          disabled: Boolean(snapshot.stopRequestedTurnId && snapshot.stopRequestedTurnId === snapshot.activeTurnId),
          onPress: () => void task.interrupt().catch((error) => setQueueError(error instanceof Error ? error.message : String(error))),
        } : undefined}
        attachmentPreview={localAttachments?.preview ?? (task && attachments.length > 0 ? <ComposerAttachmentPreview
          attachments={attachments}
          task={task}
          onRemove={(attachment) => void removeAttachment(attachment)}
        /> : undefined)}
        maxLength={MAX_TASK_MESSAGE_CHARACTERS}
        onInputFocus={() => updateLayout({ type: "focus" })}
        onInputBlur={() => { if (!preserveExpandedRef.current) updateLayout({ type: "blur" }); }}
        onInputPressIn={() => updateLayout({ type: "focus" })}
        onContentSizeChange={(height) => updateLayout({ type: "content-size-changed", height })}
        onChangeText={(value) => {
          if (v3) updateLayout({ type: "focus" });
          setInput(value);
          setQueueError(null);
          setComposerNotice(null);
        }}
        onAttachmentPressIn={beginControlPress}
        onAttachmentPressOut={endControlPress}
        onAttachmentPress={localAttachments?.open ?? openAttachmentSheet}
        onQuickPhrasesPress={() => setQuickPhrasesOpen(true)}
        onSubmit={() => { if (!sendLocked && !sendLockRef?.current) void submit(); }}
        onRootBlur={(focusEvent) => {
          // Toolbar focus stays inside the composer, even before press-in fires.
          if (focusEvent.currentTarget.contains(focusEvent.relatedTarget)) return;
          if (!preserveExpandedRef.current) updateLayout({ type: "blur" });
        }}
      />
      </ComposerRecoveryFrame>
      <Modal
        testID="quick-phrases-picker"
        visible={quickPhrasesOpen}
        transparent
        animationType={Platform.OS === "web" ? "none" : "slide"}
        onRequestClose={() => setQuickPhrasesOpen(false)}
      >
        <View style={styles.quickPhraseOverlay}>
          <Pressable
            accessibilityLabel={t("common.close")}
            style={styles.quickPhraseBackdrop}
            onPress={() => setQuickPhrasesOpen(false)}
          />
          <View accessibilityViewIsModal style={styles.quickPhraseSheet}>
            <View style={styles.quickPhraseHeader}>
              <Text accessibilityRole="header" style={styles.quickPhraseHeading}>
                {t("settings_personalization.quick_phrases_title")}
              </Text>
              <Pressable
                testID="quick-phrase-picker-close"
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={() => setQuickPhrasesOpen(false)}
                style={styles.quickPhraseClose}
              >
                <X size={20} color={colors.textMuted} />
              </Pressable>
            </View>
            {appPreferences.quickPhrases.length ? (
              <ScrollView style={styles.quickPhraseList} keyboardShouldPersistTaps="handled">
                {appPreferences.quickPhrases.map((phrase) => (
                  <Pressable
                    key={phrase.id}
                    testID={`quick-phrase-use-${phrase.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t("settings_personalization.insert_phrase", { p0: phrase.title })}
                    onPress={() => insertQuickPhrase(phrase.content)}
                    style={styles.quickPhraseOption}
                  >
                    <Text style={styles.quickPhraseTitle}>{phrase.title}</Text>
                    <Text numberOfLines={3} style={styles.quickPhraseContent}>{phrase.content}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text testID="quick-phrase-picker-empty" style={styles.quickPhraseEmpty}>
                {t("settings_personalization.quick_phrases_empty")}
              </Text>
            )}
            <Text style={styles.quickPhraseNote}>
              {t("settings_personalization.quick_phrase_send_note")}
            </Text>
          </View>
        </View>
      </Modal>
    </>
  );
}
