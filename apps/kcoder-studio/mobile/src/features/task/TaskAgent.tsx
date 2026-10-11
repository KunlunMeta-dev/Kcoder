import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { ApprovalCard, QuestionCard } from "@/components/interaction-cards";
import { beginProgrammaticFollow } from "@/components/message-follow-state";
import { reasoningEffortLabel } from "@/storage/new-workspace-preferences";
import { spacing } from "@/theme";
import { ArchiveRestore, ArrowDown, ChevronDown, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StagedAttachmentChip } from "./TaskAttachments";
import { TaskComposer } from "./TaskComposer";
import { TaskInteractions } from "./TaskInteractions";
import { useTaskAppearance } from "./taskStyles";
import { TaskSubagents, taskSubagentViewKey } from "./TaskSubagents";
import { TaskTranscript } from "./TaskTranscript";
import { type AgentPanelProps } from "./types";
import { useTaskAgentState } from "./useTaskAgentState";
import { useTaskAttachments } from "./useTaskAttachments";
import { useTaskCommands } from "./useTaskCommands";
import { useTaskHistory } from "./useTaskHistory";
import { useTaskModelPreferences } from "./useTaskModelPreferences";
import { useTaskSending } from "./useTaskSending";

export function AgentPanel(props: AgentPanelProps) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const step0 = useTaskAgentState(props);
  const step1 = useTaskCommands(step0);
  const step2 = useTaskSending(step1);
  const step3 = useTaskHistory(step2);
  const step4 = useTaskAttachments(step3);
  const step5 = useTaskModelPreferences(step4);
  const model = step5;
  const {
    task,
    bottomInset,
    snapshot,
    queuedMessages,
    attachments,
    attachmentError,
    unarchiveError,
    setUnarchiveError,
    unarchiving,
    setUnarchiving,
    queueError,
    composerNotice,
    messageListRef,
    messageFollowState,
    webPrependAnchor,
    showJumpToLatest,
    setShowJumpToLatest,
    slashCommands,
    selectSlashCommand,
    removeQueuedMessage,
    handleMessageListLayout,
    removeAttachment,
    openModelPicker,
    selectedModelOption,
  } = model;
  return (
    <View style={styles.panel}>
      <TaskSubagents
        key={taskSubagentViewKey(task)}
        task={task}
        bottomInset={bottomInset}
      />
      <View onLayout={handleMessageListLayout} style={styles.messageListStage}>
        <TaskTranscript model={model} />
        {showJumpToLatest ? (
          <Pressable
            testID="jump-to-latest"
            accessibilityRole="button"
            accessibilityLabel={t("task.jump_to_latest_message")}
            onPress={() => {
              // Keep loaded history, but an older prepend must not override
              // this explicit return-to-latest visual intent.
              webPrependAnchor.current = null;
              messageFollowState.current = beginProgrammaticFollow();
              setShowJumpToLatest(false);
              messageListRef.current?.scrollToEnd({ animated: true });
            }}
            style={styles.jumpToLatest}
          >
            <ArrowDown size={16} color={colors.text} />
            <Text style={styles.jumpToLatestText}>{t("task.latest")}</Text>
          </Pressable>
        ) : null}
      </View>
      {!snapshot.connected ? (
        <View accessibilityRole="alert" style={styles.connectionBanner}>
          <ActivityIndicator size="small" color={colors.yellow} />
          <Text style={styles.connectionBannerText}>
            {t(
              "task.disconnected_reconnecting_automatically_the_latest_server_state_will",
            )}
          </Text>
        </View>
      ) : null}
      {snapshot.interaction?.kind === "approval" ? (
        <ApprovalCard
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onRespond={(decision) => task.respondApproval(decision)}
        />
      ) : null}
      {snapshot.interaction?.kind === "question" ? (
        <QuestionCard
          key={snapshot.interaction.requestId}
          interaction={snapshot.interaction}
          pendingCount={snapshot.interactionCount}
          onSubmit={(answers) => task.respondQuestions(answers)}
          onCancel={() => task.cancelQuestions()}
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
            { paddingBottom: Math.max(bottomInset, spacing.sm) },
          ]}
        >
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
          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.attachmentList}
            >
              {attachments.map((attachment) => (
                <StagedAttachmentChip
                  key={attachment.path}
                  attachment={attachment}
                  task={task}
                  onRemove={() => void removeAttachment(attachment)}
                />
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
          <TaskComposer model={model} />
          <View style={styles.composerMeta}>
            <Pressable
              testID="conversation-model-selector"
              accessibilityLabel={t("task.change_model_and_reasoning_effort")}
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
              style={styles.modelSelectorMeta}
            >
              <Text numberOfLines={1} style={styles.model}>
                {selectedModelOption?.displayName ??
                  (snapshot.pendingTurnPreferences?.model ?? snapshot.model)?.split("::").at(-1) ??
                  t("task.server_default_model")}
                {snapshot.reasoningEffort
                  ? ` · ${reasoningEffortLabel(snapshot.reasoningEffort)}`
                  : ""}
              </Text>
              <ChevronDown size={12} color={colors.textDim} />
            </Pressable>
            <Text style={styles.connection}>
              {queuedMessages.length > 0
                ? t("task.queued", { p0: queuedMessages.length })
                : snapshot.connected
                  ? t("task.connected")
                  : t("task.offline")}
            </Text>
          </View>
        </View>
      )}
      <TaskInteractions model={model} />
    </View>
  );
}
