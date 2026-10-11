import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { MAX_TASK_MESSAGE_CHARACTERS } from "@/protocol/task-message-limits";
import { ArrowUp, Paperclip, Square, X } from "lucide-react-native";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StagedAttachmentChip } from "./TaskAttachments";
import { useTaskAppearance } from "./taskStyles";
import type { useTaskModelPreferences } from "./useTaskModelPreferences";

export function TaskComposer({
  model,
}: {
  model: ReturnType<typeof useTaskModelPreferences>;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const {
    task,
    retainedOutbox,
    snapshot,
    input,
    setInput,
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
      {failedSubmissions.length > 0 ? (
        <View testID="failed-submissions" style={styles.failedDraftList}>
          {failedSubmissions.map((submission, index) => {
            const isUnknown = submission.outcome === "unknown";
            const isPending = submission.retrying;
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
                style={styles.failedDraftCard}
              >
                <View style={styles.failedDraftHeader}>
                  <View style={styles.failedDraftCopy}>
                    <Text style={styles.failedDraftTitle}>
                      {isPending
                        ? submission.phase === "preparing"
                          ? t("task.failed_submission_preparing")
                          : submission.phase === "retaining"
                            ? t("task.failed_submission_retaining")
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
                      {isPending
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
                        isUnknown
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
                          {isUnknown
                            ? t("task.check_send_status_short")
                            : t("task.retry")}
                        </Text>
                      )}
                    </Pressable>
                    <Pressable
                      testID="dismiss-failed-submission"
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        isUnknown
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
      ) : null}
      <View testID="message-input-root" style={styles.composer}>
        <Pressable
          testID="composer-attachment"
          accessibilityLabel={t("task.add_attachment")}
          disabled={!snapshot.connected}
          accessibilityState={{ disabled: !snapshot.connected }}
          onPress={openAttachmentSheet}
          style={[
            styles.attachButton,
            !snapshot.connected && styles.sendDisabled,
          ]}
        >
          <Paperclip size={19} color={colors.textMuted} />
        </Pressable>
        <TextInput
          ref={messageInputRef}
          testID="message-input"
          value={input}
          onChangeText={(value) => {
            setInput(value);
            setQueueError(null);
            setComposerNotice(null);
          }}
          maxLength={MAX_TASK_MESSAGE_CHARACTERS}
          multiline
          placeholder={
            snapshot.running
              ? t("task.type_a_message_to_queue")
              : t("task.send_a_message")
          }
          placeholderTextColor={colors.textDim}
          style={styles.composerInput}
          editable={snapshot.connected}
        />
        {snapshot.running ? (
          <Pressable
            testID="stop-turn"
            accessibilityRole="button"
            accessibilityLabel={
              snapshot.stopRequestedTurnId === snapshot.activeTurnId
                ? t("task.stopping")
                : t("task.stop")
            }
            disabled={Boolean(snapshot.stopRequestedTurnId && snapshot.stopRequestedTurnId === snapshot.activeTurnId)}
            onPress={() => void task.interrupt().catch((error) => setQueueError(error instanceof Error ? error.message : String(error)))}
            style={styles.stopButton}
          >
            {snapshot.stopRequestedTurnId === snapshot.activeTurnId ? <ActivityIndicator size="small" color={colors.text} /> : <Square size={14} fill={colors.text} color={colors.text} />}
          </Pressable>
        ) : null}
        <Pressable
          testID={snapshot.running ? "queue-message" : "send-message"}
          accessibilityRole="button"
          accessibilityLabel={
            snapshot.running ? t("task.queue_message") : t("task.send")
          }
          disabled={!canSend}
          accessibilityState={{ disabled: !canSend }}
          onPress={() => void submit()}
          style={[styles.sendButton, !canSend && styles.sendDisabled]}
        >
          <ArrowUp size={19} color={colors.accentText} />
        </Pressable>
      </View>
    </>
  );
}
