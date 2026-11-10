import { useConversationModelLabel } from "./use-conversation-model-label";
import { useRememberDraftProject } from "./useLastDraftProject";
import { useInterfaceVersion } from "@/storage/interface-version";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ApprovalCard, AsyncQuestionCard, AsyncQuestionListError, QuestionCard, interactionCardIdentity } from "@/components/interaction-cards";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { spacing } from "@/theme";
import { ArchiveRestore, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { ComposerMetaRow, TaskComposer } from "./TaskComposer";
import { TaskGoalControls } from "./TaskGoalControls";
import { TaskPlanControls } from "./TaskPlanControls";
import { composerBottomPadding, useKeyboardVisible } from "@/components/use-keyboard-visible";
import { TaskPermissionSelector } from "./TaskPermissionSelector";
import { LiveTaskExpertSelector } from "./TaskExpertSelector";
import { TaskInteractions } from "./TaskInteractions";
import { useTaskAppearance } from "./taskStyles";
import { TaskSubagents, taskSubagentViewKey } from "./TaskSubagents";
import { JumpToLatestButton, TaskTranscript, type TranscriptReadAnchor } from "./TaskTranscript";
import { handleTranscriptLayoutChange } from "./useTaskHistory";
import { type AgentPanelProps } from "./types";
import { useTaskAgentState } from "./useTaskAgentState";
import { useTaskAttachments } from "./useTaskAttachments";
import { useTaskCommands } from "./useTaskCommands";
import { useTaskHistory } from "./useTaskHistory";
import { useTaskModelPreferences } from "./useTaskModelPreferences";
import { useTaskSending } from "./useTaskSending";
import { useTranscriptActions } from "./useTranscriptActions";
import { selectorForInteraction } from "@/runtime/task-runtime/interactions";
import { ComposerFloatingLayer } from "./ComposerFloatingLayer";
import { TaskConnectionNotice } from "./TaskConnectionNotice";
import { useRouter } from "expo-router";

export function AgentPanel(props: AgentPanelProps & { draftFlushRef?: RefObject<(() => Promise<void>) | null>; planOpenRequest?: object; permissionOpenRequest?: object; expertOpenRequest?: object; subagentsOpenRequest?: object; quickPhrasesOpenRequest?: object; workspaceReady?: boolean; displayOwner?: object; searchOpen?: boolean; onSearchClose?(): void; initialReadAnchor?: TranscriptReadAnchor; onReadAnchor?(anchor: TranscriptReadAnchor, userDecision?: boolean): void }) {
  useLocale();
  const router = useRouter();
  const { styles } = useTaskAppearance();
  const workspaceReady = props.workspaceReady !== false;
  const state = useTaskAgentState(props, workspaceReady);
  useEffect(() => {
    const ref = props.draftFlushRef;
    if (!ref || !workspaceReady) return;
    const flush = () => Promise.resolve(props.onDraftChange?.(state.latestInputRef.current || undefined));
    ref.current = flush;
    return () => { if (ref.current === flush) ref.current = null; };
  }, [props.draftFlushRef, props.onDraftChange, workspaceReady, state.latestInputRef]);
  const history = useTaskHistory(state);
  const { task, snapshot, bottomInset, showJumpToLatest } = history;
  const v3 = useInterfaceVersion() === "v3";
  const jumpInComposer = v3 && workspaceReady && !snapshot.archivedAt;
  const latestAction = showJumpToLatest ? <JumpToLatestButton model={history} onReadAnchor={props.onReadAnchor} inComposer={jumpInComposer} /> : null;
  const focused = useIsFocused();
  useRememberDraftProject(props.profile ?? null, props.server, snapshot.cwd,
    v3 && !props.demo && focused && workspaceReady && snapshot.connected && snapshot.configurationReady !== false);
  const actions = useTranscriptActions(task, workspaceReady && !props.demo && Boolean(props.profile && props.server));
  const transcriptOwnerRef = useRef<object | undefined>(props.displayOwner ?? task);
  transcriptOwnerRef.current = props.displayOwner ?? task;
  return (
    <ComposerFloatingLayer style={styles.panel}>
      {workspaceReady ? <TaskSubagents key={taskSubagentViewKey(task)} task={task} bottomInset={bottomInset}
        hideTrigger openRequest={props.subagentsOpenRequest}
        focusQuestion={snapshot.interaction?.kind === "question" && snapshot.interaction.sourceAgent
          ? snapshot.interaction : null}
        sourceAgentRouteFocus={props.interactionRouteSourceAgentFocus ?? null} /> : null}
      <View key="history" onLayout={(event) => handleTranscriptLayoutChange({
        ...history,
        ownerRef: transcriptOwnerRef,
      }, event)} style={styles.messageListStage}>
        <TaskTranscript connectionNoticeOwned actions={actions} searchOpen={props.searchOpen} onSearchClose={props.onSearchClose} model={{ ...history, displayOwner: props.displayOwner }} readOnly={!workspaceReady}
          initialAnchor={props.initialReadAnchor} onReadAnchor={props.onReadAnchor} />
        {!jumpInComposer ? latestAction : null}
      </View>
      {v3 && workspaceReady ? <TaskPlanControls owner={task} snapshot={snapshot} openRequest={props.planOpenRequest} /> : null}
      <TaskConnectionNotice key={snapshot.threadId} snapshot={snapshot} onReconnect={() => task.reconnectNow()}
        onReauthorize={() => router.push("/settings-connections")} />
      {actions.recovery}
      {actions.dialog}
      {workspaceReady ? <TaskWritablePanel state={state} history={history} aboveComposer={jumpInComposer ? latestAction : undefined} quickPhrasesOpenRequest={props.quickPhrasesOpenRequest} permissionOpenRequest={props.permissionOpenRequest} expertOpenRequest={props.expertOpenRequest} /> : null}
    </ComposerFloatingLayer>
  );
}

// Mount the mutation hooks only after the exact owner's local preferences are restored.
// The parent owns the transcript and follow refs across this transition.
function TaskWritablePanel({ state, history, quickPhrasesOpenRequest, permissionOpenRequest, expertOpenRequest, aboveComposer }: {
  aboveComposer?: ReactNode;
  quickPhrasesOpenRequest?: object;
  permissionOpenRequest?: object;
  expertOpenRequest?: object;
  state: ReturnType<typeof useTaskAgentState>;
  history: ReturnType<typeof useTaskHistory<ReturnType<typeof useTaskAgentState>>>;
}) {
  const v3 = useInterfaceVersion() === "v3";
  const isFocused = useIsFocused();
  const keyboardVisible = useKeyboardVisible();
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  const [expertSheetOpen, setExpertSheetOpen] = useState(false);
  const [composerOverlayPressPending, setComposerOverlayPressPending] = useState(false);
  const composerOverlayPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdComposerForOverlay = () => {
    if (composerOverlayPressTimer.current) clearTimeout(composerOverlayPressTimer.current);
    setComposerOverlayPressPending(true);
    composerOverlayPressTimer.current = setTimeout(() => {
      composerOverlayPressTimer.current = null;
      setComposerOverlayPressPending(false);
    }, 250);
  };
  const setPermissionOverlayOpen = (open: boolean) => {
    setPermissionSheetOpen(open);
    if (!open) {
      if (composerOverlayPressTimer.current) {
        clearTimeout(composerOverlayPressTimer.current);
        composerOverlayPressTimer.current = null;
      }
      setComposerOverlayPressPending(false);
    }
  };
  const setExpertOverlayOpen = useCallback((open: boolean) => {
    setExpertSheetOpen(open);
    if (!open) {
      if (composerOverlayPressTimer.current) {
        clearTimeout(composerOverlayPressTimer.current);
        composerOverlayPressTimer.current = null;
      }
      setComposerOverlayPressPending(false);
    }
  }, []);
  useEffect(() => () => {
    if (composerOverlayPressTimer.current) clearTimeout(composerOverlayPressTimer.current);
  }, []);
  const { styles, colors } = useTaskAppearance();
  const commands = useTaskCommands(state);
  const sending = useTaskSending(commands);
  const attachmentsModel = useTaskAttachments({ ...sending, ...history });
  const model = useTaskModelPreferences(attachmentsModel);
  const { task, bottomInset, snapshot, queuedMessages, attachments, attachmentError,
    unarchiveError, setUnarchiveError, unarchiving, setUnarchiving, queueError,
    composerNotice, slashCommands, selectSlashCommand, removeQueuedMessage,
    removeAttachment, openModelPicker } = model;
  const expertProfileScope = JSON.stringify([model.profile?.id, model.profile?.baseUrl,
    model.profile?.authorizationGeneration, model.profile?.deviceId]);
  const expertServerScope = JSON.stringify([model.server?.id, model.server?.transport,
    model.server?.workspacePath, model.server?.host, model.server?.user, model.server?.port,
    model.server?.command, model.server?.settingsFile, model.server?.profile]);
  const expertOwner = useMemo(() => ({}), [task, task.client, task.clientGeneration,
    snapshot.threadId, snapshot.cwd, expertProfileScope, expertServerScope]);
  const expertBusyOwner = useMemo(() => ({}), [task, task.runtimeInstanceNonce,
    snapshot.threadId, snapshot.cwd, expertProfileScope, expertServerScope]);
  const expertBusyOwnerRef = useRef(expertBusyOwner);
  expertBusyOwnerRef.current = expertBusyOwner;
  const expertBusyRef = useRef<{ owner: object; busy: boolean }>({ owner: expertBusyOwner, busy: false });
  const [expertBusyState, setExpertBusyState] = useState<{ owner: object; busy: boolean }>({ owner: expertBusyOwner, busy: false });
  const expertSendLocked = expertBusyState.owner === expertBusyOwner && expertBusyState.busy;
  const expertSendLockRef = useMemo(() => ({
    get current() { return expertBusyRef.current.owner === expertBusyOwner && expertBusyRef.current.busy; },
  }), [expertBusyOwner]);
  const onExpertBusyChange = useCallback((busy: boolean) => {
    if (expertBusyOwnerRef.current !== expertBusyOwner) return;
    const next = { owner: expertBusyOwner, busy };
    expertBusyRef.current = next;
    setExpertBusyState(next);
  }, [expertBusyOwner]);
  const asyncQuestions = useSyncExternalStore(
    task.subscribe,
    task.getAsyncQuestionSnapshot,
    task.getAsyncQuestionSnapshot,
  );
  const modelLabel = useConversationModelLabel(task, snapshot, model.modelOptions, model.profile, model.server, model.demo);
  return <>
      {asyncQuestions.supported && asyncQuestions.questions.length > 0 ? (
        <ScrollView
          testID="async-question-list"
          style={{ maxHeight: 260, marginHorizontal: spacing.lg, marginBottom: spacing.md }}
          contentContainerStyle={{ gap: spacing.md }}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {asyncQuestions.questions.map((question, index) => (
            <AsyncQuestionCard
              key={question.questionId}
              question={question}
              ownerKey={JSON.stringify([task.runtimeInstanceNonce, task.clientGeneration])}
              disabled={!task.canMutateAsyncQuestions()}
              busy={asyncQuestions.mutatingQuestionIds.includes(question.questionId)}
              listError={index === 0 ? asyncQuestions.error : undefined}
              onAnswer={(input) => task.answerAsyncQuestion(input)}
              onCancel={(input) => task.cancelAsyncQuestion(input)}
              onRefresh={() => void task.refreshAsyncQuestions()}
            />
          ))}
        </ScrollView>
      ) : asyncQuestions.supported && asyncQuestions.error ? (
        <AsyncQuestionListError
          error={asyncQuestions.error}
          onRefresh={() => void task.refreshAsyncQuestions()}
        />
      ) : null}
      {snapshot.interactionFocusStatus ? (
        <Text testID={`interaction-focus-${snapshot.interactionFocusStatus}`} accessibilityRole="alert"
          style={{ color: colors.textMuted, marginHorizontal: spacing.lg, marginBottom: spacing.sm }}>
          {snapshot.interactionFocusStatus === "stale" ? t("inbox.stale") : t("inbox.focused_readonly")}
        </Text>
      ) : null}
      {snapshot.interaction?.kind === "approval" ? (
        <ApprovalCard
          key={interactionCardIdentity(snapshot.interaction)}
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onRespond={(decision) => task.respondApproval(decision, selectorForInteraction(snapshot.interaction!))}
        />
      ) : null}
      {snapshot.interaction?.kind === "question" && !snapshot.interaction.sourceAgent ? (
        <QuestionCard
          key={interactionCardIdentity(snapshot.interaction)}
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onSubmit={(answers) => task.respondQuestions(answers, selectorForInteraction(snapshot.interaction!))}
          onCancel={() => task.cancelQuestions(selectorForInteraction(snapshot.interaction!))}
        />
      ) : null}
      {snapshot.archivedAt ? (
        <View
          style={[
            styles.archivedCalloutWrap,
            { paddingBottom: Math.max(bottomInset, spacing.md) },
          ]}
        >
          <View style={styles.archivedCallout}>
            <ArchiveRestore size={19} color={colors.textMuted} />
            <Text style={styles.archivedCalloutText}>
              {t("task.this_task_is_archived_restore_it_to_continue")}
            </Text>
            <Pressable
              testID="unarchive-task"
              disabled={!snapshot.connected || unarchiving}
              accessibilityState={{
                disabled: !snapshot.connected || unarchiving,
                busy: unarchiving,
              }}
              onPress={() =>
                void (async () => {
                  if (unarchiving) return;
                  setUnarchiving(true);
                  setUnarchiveError(null);
                  try {
                    await task.unarchive();
                  } catch (value) {
                    setUnarchiveError(
                      value instanceof Error ? value.message : String(value),
                    );
                  } finally {
                    setUnarchiving(false);
                  }
                })()
              }
              style={[
                styles.archivedCalloutButton,
                (!snapshot.connected || unarchiving) && styles.sendDisabled,
              ]}
            >
              {unarchiving ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <Text style={styles.archivedCalloutButtonText}>
                  {t("task.restore")}
                </Text>
              )}
            </Pressable>
          </View>
          {unarchiveError ? (
            <Text accessibilityRole="alert" style={styles.attachmentError}>
              {unarchiveError}
            </Text>
          ) : null}
        </View>
      ) : (
        <View
          style={[
            styles.composerWrap,
            { paddingBottom: composerBottomPadding(Platform.OS, keyboardVisible, bottomInset, spacing.sm) },
          ]}
        >
          <TaskGoalControls task={task} snapshot={snapshot} />
          {attachmentError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentError}
            >
              {attachmentError}
            </Text>
          ) : null}
          {queueError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.attachmentError}
            >
              {queueError}
            </Text>
          ) : null}
          {composerNotice ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.composerNotice}
            >
              {composerNotice}
            </Text>
          ) : null}
          {queuedMessages.length > 0 ? (
            <ScrollView
              testID="queued-messages"
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.queueList}
            >
              {queuedMessages.map((message, index) => (
                <View
                  key={message.id}
                  testID={`queued-message-${index}`}
                  style={styles.queueChip}
                >
                  <View style={styles.queueIndex}>
                    <Text style={styles.queueIndexText}>{index + 1}</Text>
                  </View>
                  <View style={styles.queueCopy}>
                    <Text numberOfLines={1} style={styles.queueText}>
                      {message.content ||
                        t("task.attachments", {
                          p0: message.attachments.length,
                        })}
                    </Text>
                    <Text style={styles.queueMeta}>
                      {message.staging
                        ? `${t("task.saving_queued_message")} ·`
                        : t("task.waiting_for_current_turn")}{" "}
                      {message.attachments.length > 0
                        ? t("task.attachments", {
                            p0: message.attachments.length,
                          })
                        : t("task.message")}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={t("task.remove_queued_message", {
                      p0: index + 1,
                    })}
                    disabled={message.staging}
                    onPress={() => removeQueuedMessage(message.id)}
                    style={styles.queueRemove}
                  >
                    <X size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {slashCommands.length > 0 ? (
            <ScrollView
              testID="slash-command-menu"
              accessibilityRole="menu"
              nestedScrollEnabled
              showsVerticalScrollIndicator
              contentContainerStyle={styles.slashMenuContent}
              style={styles.slashMenu}
            >
              {slashCommands.map((command) => (
                <Pressable
                  key={command.name}
                  testID={`slash-command-${command.name.slice(1)}`}
                  accessibilityRole="menuitem"
                  onPress={() => selectSlashCommand(command)}
                  style={({ pressed }) => [
                    styles.slashMenuRow,
                    pressed && styles.slashMenuRowPressed,
                  ]}
                >
                  <Text style={styles.slashMenuName}>{command.name}</Text>
                  <Text numberOfLines={1} style={styles.slashMenuDescription}>
                    {command.description}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <TaskComposer
            aboveComposer={aboveComposer}
            quickPhrasesOpenRequest={quickPhrasesOpenRequest}
            sendLocked={expertSendLocked}
            sendLockRef={expertSendLockRef}
            toolbar={<ComposerMetaRow
            modelSelector={<Pressable
              testID="conversation-model-selector"
              hitSlop={v3 ? 6 : undefined}
              accessibilityLabel={`${t("task.change_model_and_reasoning_effort")} · ${modelLabel}`}
              disabled={
                !snapshot.connected ||
                snapshot.running ||
                Boolean(snapshot.archivedAt)
              }
              accessibilityState={{
                disabled:
                  !snapshot.connected ||
                  snapshot.running ||
                  Boolean(snapshot.archivedAt),
              }}
              onPress={openModelPicker}
              onPressIn={holdComposerForOverlay}
              style={styles.modelSelectorMeta}
            >
              <Text numberOfLines={1} style={styles.model}>
                {modelLabel}
                {snapshot.reasoningEffort
                  ? ` · ${reasoningEffortLabel(snapshot.reasoningEffort)}`
                  : ""}
              </Text>
            </Pressable>}
            permissionSelector={<TaskPermissionSelector
              openRequest={permissionOpenRequest}
              hideTrigger={v3}
              task={task}
              snapshot={snapshot}
              profile={state.profile}
              server={state.server}
              demo={state.demo}
              scopeActive={isFocused}
              onOpenChange={setPermissionOverlayOpen}
              onTriggerPressIn={holdComposerForOverlay}
            />}
            expertSelector={<LiveTaskExpertSelector owner={expertOwner} busyOwner={expertBusyOwner} task={task} snapshot={snapshot} scopeActive={isFocused}
              openRequest={expertOpenRequest} hideTrigger
              onOpenChange={setExpertOverlayOpen} onTriggerPressIn={holdComposerForOverlay} onBusyChange={onExpertBusyChange} />}
            status={queuedMessages.length > 0 || !snapshot.connected ? <Text numberOfLines={1} style={styles.connection}>
              {queuedMessages.length > 0
                ? t("task.queued", { p0: queuedMessages.length })
                : snapshot.connected
                  ? t("task.connected")
                  : t("task.offline")}
            </Text> : null}
          />}
            model={model}
            externalOverlayOpen={permissionSheetOpen || expertSheetOpen || composerOverlayPressPending}
          />

        </View>
      )}
      <TaskInteractions model={model} />
    </>;
}
