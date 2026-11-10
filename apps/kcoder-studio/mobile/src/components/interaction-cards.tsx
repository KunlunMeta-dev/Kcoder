import { t } from "@/i18n";
import { selectorForInteraction } from "@/runtime/task-runtime/interactions";
import { useLocale } from "@/i18n/use-locale";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ShieldCheck,
  Square,
  CheckSquare,
  HelpCircle,
} from "lucide-react-native";
import type {
  AsyncQuestionAnswerPayload,
  AsyncQuestionRecord,
  ApprovalInteraction,
  QuestionInteraction,
  QuestionView,
} from "@/runtime/task-runtime";
import { Button } from "./ui";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { approvalActionPresentation } from "./approval-action";

// Question IDs are protocol data; inherited object members are not answers.
function ownAnswer<T>(answers: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : undefined;
}

// Expo lowers object spreads to Object.assign, whose __proto__ setter drops
// valid protocol keys. Define all dynamic answer properties as own properties.
function withAnswer<T>(answers: Record<string, T>, id: string, value: T): Record<string, T> {
  return Object.fromEntries([...Object.entries(answers), [id, value]]);
}

export function interactionCardIdentity(
  interaction: ApprovalInteraction | QuestionInteraction,
): string {
  const source = interaction.kind === "question" ? interaction.sourceAgent : undefined;
  // Drafts and response errors belong to the same exact owner as reply dispatch.
  // Receipt status and busy changes keep that identity; another run does not.
  return JSON.stringify([
    selectorForInteraction(interaction),
    source?.parentSessionId ?? null,
    source?.agentId ?? null,
    source?.backgroundRun?.parentSessionId ?? null,
    source?.backgroundRun?.agentId ?? null,
    source?.backgroundRun?.runId ?? null,
  ]);
}

export function ApprovalCard({
  interaction,
  onRespond,
  pendingCount = 1,
}: {
  interaction: ApprovalInteraction;
  pendingCount?: number;
  onRespond(
    decision: "accept" | "accept_for_session" | "decline" | "cancel",
  ): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [responseFailure, setResponseFailure] = useState<{
    identity: string;
    requestId: number;
    message: string;
  } | null>(null);
  const identity = interactionCardIdentity(interaction);
  const available = interaction.availableDecisions ?? [
    "accept",
    "accept_for_session",
    "decline",
    "cancel",
  ];
  const action = approvalActionPresentation(interaction.action);
  const responseError =
    responseFailure?.identity === identity
      ? responseFailure.message
      : null;
  const respond = (decision: Parameters<typeof onRespond>[0]) =>
    runInteractionResponse(
      interaction.requestId,
      identity,
      "Approval response",
      () => onRespond(decision),
      setResponseFailure,
    );
  return (
    <View testID="approval-card" style={styles.card}>
      <View style={styles.titleRow}>
        <ShieldCheck size={20} color={colors.yellow} />
        <Text style={styles.title}>
          {t("task.approval_required")}
          {pendingCount > 1 ? t("task.pending", { p0: pendingCount }) : ""}
        </Text>
      </View>
      <ScrollView
        style={styles.interactionScroll}
        contentContainerStyle={styles.interactionScrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.body}>{interaction.reason}</Text>
        <View style={styles.codeBox}>
          <Text selectable style={styles.code}>
            {action.text}
          </Text>
        </View>
        {!action.safeToApprove ? (
          <Text accessibilityRole="alert" style={styles.unsafeApproval}>
            {t("task.the_operation_input_cannot_be_displayed_completely_and")}
          </Text>
        ) : null}
      </ScrollView>
      {responseError ? (
        <Text
          testID="interaction-response-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.responseError}
        >
          {responseError}
        </Text>
      ) : null}
      {available.includes("decline") ||
      available.includes("accept_for_session") ? (
        <View style={styles.row}>
          {available.includes("decline") ? (
            <Button
              testID="approval-decline"
              disabled={interaction.responding}
              style={styles.flex}
              onPress={() => respond("decline")}
            >
              {t("task.decline")}
            </Button>
          ) : null}
          {available.includes("accept_for_session") ? (
            <Button
              testID="approval-accept-session"
              disabled={interaction.responding || !action.safeToApprove}
              style={styles.compactButton}
              onPress={() => respond("accept_for_session")}
            >
              {t("task.allow_for_session")}
            </Button>
          ) : null}
        </View>
      ) : null}
      {available.includes("accept") ? (
        <Button
          testID="approval-accept"
          disabled={interaction.responding || !action.safeToApprove}
          variant="primary"
          onPress={() => respond("accept")}
        >
          {interaction.responding
            ? t("task.submitting")
            : action.safeToApprove
              ? t("task.allow_once")
              : t("task.incomplete_input_approval_disabled")}
        </Button>
      ) : null}
      {available.includes("cancel") ? (
        <Button
          testID="approval-cancel"
          disabled={interaction.responding}
          variant="ghost"
          onPress={() => respond("cancel")}
        >
          {t("task.cancel_request")}
        </Button>
      ) : null}
    </View>
  );
}

export function QuestionCard({
  interaction,
  onSubmit,
  onCancel,
  cancelLabel,
  disabled = false,
  pendingCount = 1,
}: {
  interaction: QuestionInteraction;
  pendingCount?: number;
  onSubmit(answers: Record<string, string[]>): void;
  onCancel(): void;
  cancelLabel?: string;
  disabled?: boolean;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [responseFailure, setResponseFailure] = useState<{
    identity: string;
    requestId: number;
    message: string;
  } | null>(null);
  const identity = interactionCardIdentity(interaction);
  useEffect(() => {
    setSelected({});
    setFreeform({});
    setResponseFailure(null);
  }, [identity]);
  const answers = useMemo(() => {
    const customAnswers = Object.entries(freeform).filter(([, value]) => value.trim()).map<[string, string[]]>(([id, value]) => {
      const question = interaction.questions.find((item) => item.id === id);
      return [id, question?.multiSelect
        ? [...new Set([...(ownAnswer(selected, id) ?? []), value.trim()])]
        : [value.trim()]];
    });
    return Object.fromEntries([...Object.entries(selected), ...customAnswers]);
  }, [freeform, interaction.questions, selected]);

  const toggle = (questionId: string, value: string, multi: boolean) => {
    setSelected((current) => {
      if (!multi) return withAnswer(current, questionId, [value]);
      const values = ownAnswer(current, questionId) ?? [];
      return withAnswer(current, questionId, values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value]);
    });
  };
  const responseError =
    responseFailure?.identity === identity
      ? responseFailure.message
      : null;
  const submit = () =>
    runInteractionResponse(
      interaction.requestId,
      identity,
      "Question response",
      () => onSubmit(answers),
      setResponseFailure,
    );
  const cancel = () =>
    runInteractionResponse(
      interaction.requestId,
      identity,
      "Question cancellation",
      onCancel,
      setResponseFailure,
    );

  return (
    <View testID="question-card" style={styles.card}>
      <View style={styles.titleRow}>
        <HelpCircle size={20} color={colors.blue} />
        <Text style={styles.title}>
          {t("task.kcoder_has_questions")}
          {pendingCount > 1 ? t("task.pending", { p0: pendingCount }) : ""}
        </Text>
      </View>
      {interaction.sourceAgent ? (
        <Text
          style={{ color: colors.textMuted, paddingHorizontal: spacing.md }}
        >
          {t("task.from_subagent")}
          {interaction.sourceAgent.agentId}
        </Text>
      ) : null}
      <QuestionAnswerFields
        questions={interaction.questions}
        selected={selected}
        freeform={freeform}
        disabled={disabled || Boolean(interaction.responding)}
        onToggle={toggle}
        onFreeformChange={(questionId, value) =>
          setFreeform((current) => withAnswer(current, questionId, value))
        }
      />
      {responseError ? (
        <Text
          testID="interaction-response-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.responseError}
        >
          {responseError}
        </Text>
      ) : null}
      <Button
        testID="question-submit"
        variant="primary"
        disabled={
          disabled || interaction.responding ||
          interaction.questions.some(
            (question) => !((ownAnswer(answers, question.id)?.length ?? 0) > 0),
          )
        }
        onPress={submit}
      >
        {interaction.responding
          ? t("task.submitting")
          : t("task.submit_answers")}
      </Button>
      <Button
        testID="question-cancel"
        variant="ghost"
        disabled={disabled || interaction.responding}
        onPress={cancel}
      >
        {cancelLabel ?? t("task.cancel_questions")}
      </Button>
    </View>
  );
}

export function QuestionAnswerFields({
  questions,
  selected,
  freeform,
  disabled,
  testIdPrefix = "question",
  onToggle,
  onFreeformChange,
}: {
  questions: QuestionView[];
  selected: Record<string, string[]>;
  freeform: Record<string, string>;
  disabled: boolean;
  testIdPrefix?: string;
  onToggle(questionId: string, value: string, multi: boolean): void;
  onFreeformChange(questionId: string, value: string): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <ScrollView
      style={styles.interactionScroll}
      contentContainerStyle={styles.interactionScrollContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
    >
      {questions.map((question) => (
        <View key={question.id} style={styles.question}>
          <Text style={styles.questionHeader}>{question.header}</Text>
          <Text style={styles.body}>{question.prompt}</Text>
          {question.options.map((option) => {
            const checked = (ownAnswer(selected, question.id) ?? []).includes(option.value);
            return (
              <Pressable
                key={option.value}
                disabled={disabled}
                testID={`${testIdPrefix}-option-${question.id}-${option.value}`}
                accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                accessibilityLabel={
                  option.description
                    ? `${option.label}, ${option.description}`
                    : option.label
                }
                accessibilityState={{ checked }}
                aria-checked={checked}
                onPress={() => onToggle(question.id, option.value, question.multiSelect)}
                style={[styles.option, checked && styles.optionSelected]}
              >
                {checked ? (
                  <CheckSquare size={18} color={colors.blue} />
                ) : (
                  <Square size={18} color={colors.textMuted} />
                )}
                <View style={styles.flex}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description ? (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {question.allowsFreeform ? (
            <TextInput
              accessibilityLabel={t("task.other_answer_for", { p0: question.header })}
              placeholder={t("task.enter_another_answer")}
              placeholderTextColor={colors.textDim}
              value={ownAnswer(freeform, question.id) ?? ""}
              editable={!disabled}
              onChangeText={(value) => onFreeformChange(question.id, value)}
              style={styles.input}
            />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

type AsyncQuestionCardProps = {
  question: AsyncQuestionRecord;
  ownerKey?: string;
  busy?: boolean;
  disabled?: boolean;
  listError?: string;
  onAnswer(input: {
    questionId: string;
    submissionId: string;
    expectedRevision: number;
    answers: AsyncQuestionAnswerPayload;
  }): Promise<unknown>;
  onCancel(input: { questionId: string; expectedRevision: number }): Promise<unknown>;
  onRefresh(): void;
};

export function AsyncQuestionCard(props: AsyncQuestionCardProps) {
  // Question IDs are task-scoped. Remount all local input and request state when
  // its binding changes; late operations then settle only their original card.
  return <AsyncQuestionCardBody key={JSON.stringify([props.question.threadId, props.question.questionId])} {...props} />;
}

function AsyncQuestionCardBody({
  question,
  ownerKey,
  busy = false,
  disabled = false,
  listError,
  onAnswer,
  onCancel,
  onRefresh,
}: AsyncQuestionCardProps) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // React may batch presses before committing the visible busy state.
  const mutationInFlight = useRef(false);
  // Retain the draft through read-only/reconnect transitions, but invalidate
  // queued presses and completions from before that transition. Runtime busy remains binding.
  const mutationOwner = useMemo(() => ({}), [disabled, ownerKey]);
  const mutationOwnerRef = useRef(mutationOwner);
  mutationOwnerRef.current = mutationOwner;
  const mutationIsCurrent = () => mutationOwnerRef.current === mutationOwner;
  useEffect(() => {
    mutationInFlight.current = false;
    setSubmitting(false);
  }, [mutationOwner]);
  const [responseFailure, setResponseFailure] = useState<{
    threadId: string; questionId: string; revision: number; message: string;
  } | null>(null);
  // A newer authoritative record supersedes a transport failure, even when
  // the failed request settles after that record was already refreshed.
  const currentResponseFailure = responseFailure?.threadId === question.threadId &&
    responseFailure.questionId === question.questionId && responseFailure.revision >= question.revision
    ? responseFailure.message : null;
  const recordResponseFailure = (error: unknown) => setResponseFailure(current => {
    if (current?.threadId === question.threadId && current.questionId === question.questionId &&
        current.revision > question.revision) return current;
    return { threadId: question.threadId, questionId: question.questionId, revision: question.revision,
      message: error instanceof Error ? error.message : String(error) };
  });
  const pendingSubmission = useRef<{ signature: string; id: string } | null>(null);

  const formQuestions: QuestionView[] = useMemo(() => question.questions.map((item) => ({
    id: item.id,
    header: item.header,
    prompt: item.question,
    options: item.options.map((option) => ({
      label: option.label,
      value: option.id,
      ...(option.description ? { description: option.description } : {}),
    })),
    allowsFreeform: true,
    multiSelect: item.multiSelect,
  })), [question.questions]);
  const answerPayload = useMemo(() => Object.fromEntries(
    question.questions.map((item) => {
      const draft = ownAnswer(freeform, item.id);
      // Test emptiness without changing indentation or trailing newlines.
      const text = draft?.trim() ? draft : undefined;
      return [item.id, {
        selectedOptionIds: ownAnswer(selected, item.id) ?? [],
        ...(text ? { text } : {}),
      }];
    }),
  ) as AsyncQuestionAnswerPayload, [freeform, question.questions, selected]);
  const canAnswer = question.questions.every((item) =>
    (ownAnswer(selected, item.id)?.length ?? 0) > 0 || Boolean(ownAnswer(freeform, item.id)?.trim()));
  const canContinueDelivery = Boolean(
    question.answer && (question.status === "queued" || question.status === "answer_saved"),
  );

  const submit = async () => {
    if (!mutationIsCurrent() || mutationInFlight.current || disabled || busy || question.status !== "pending" || !canAnswer) return;
    const signature = JSON.stringify([question.revision, answerPayload]);
    let submissionId = pendingSubmission.current?.signature === signature
      ? pendingSubmission.current.id
      : "";
    if (!submissionId) {
      submissionId = createAsyncQuestionSubmissionId();
      pendingSubmission.current = { signature, id: submissionId };
    }
    mutationInFlight.current = true;
    setSubmitting(true);
    setResponseFailure(null);
    try {
      await onAnswer({
        questionId: question.questionId,
        submissionId,
        expectedRevision: question.revision,
        answers: answerPayload,
      });
      if (!mutationIsCurrent()) return;
      pendingSubmission.current = null;
      setSelected({});
      setFreeform({});
    } catch (error) {
      if (mutationIsCurrent()) recordResponseFailure(error);
    } finally {
      if (mutationIsCurrent()) {
        mutationInFlight.current = false;
        setSubmitting(false);
      }
    }
  };
  const cancel = async () => {
    if (!mutationIsCurrent() || mutationInFlight.current || disabled || busy || question.status !== "pending") return;
    mutationInFlight.current = true;
    setSubmitting(true);
    setResponseFailure(null);
    try {
      await onCancel({ questionId: question.questionId, expectedRevision: question.revision });
    } catch (error) {
      if (mutationIsCurrent()) recordResponseFailure(error);
    } finally {
      if (mutationIsCurrent()) {
        mutationInFlight.current = false;
        setSubmitting(false);
      }
    }
  };
  const continueDelivery = async () => {
    const savedAnswer = question.answer;
    if (!mutationIsCurrent() || mutationInFlight.current || disabled || busy || !canContinueDelivery || !savedAnswer) return;
    mutationInFlight.current = true;
    setSubmitting(true);
    setResponseFailure(null);
    try {
      await onAnswer({
        questionId: question.questionId,
        submissionId: savedAnswer.submissionId,
        expectedRevision: question.revision,
        answers: savedAnswer.answers,
      });
    } catch (error) {
      if (mutationIsCurrent()) recordResponseFailure(error);
    } finally {
      if (mutationIsCurrent()) {
        mutationInFlight.current = false;
        setSubmitting(false);
      }
    }
  };
  const statusKey: Record<AsyncQuestionRecord["status"], string> = {
    pending: "task.async_question.status.pending",
    answer_saved: "task.async_question.status.answer_saved",
    queued: "task.async_question.status.queued",
    context_applied: "task.async_question.status.context_applied",
    delivery_unknown: "task.async_question.status.delivery_unknown",
    delivery_failed: "task.async_question.status.delivery_failed",
    cancelled: "task.async_question.status.cancelled",
    stale: "task.async_question.status.stale",
  };
  const statusColor = question.status === "delivery_failed"
    ? colors.red
    : question.status === "pending"
      ? colors.blue
      : colors.textMuted;

  return (
    <View testID={`async-question-card-${question.questionId}`} style={[styles.card, styles.asyncQuestionCard]}>
      <View style={styles.titleRow}>
        <HelpCircle size={20} color={colors.blue} />
        <Text testID="async-question-title" style={styles.title}>{t("task.async_question.title")}</Text>
      </View>
      <Text testID="async-question-status" style={[styles.status, { color: statusColor }]}>
        {t(statusKey[question.status])}
      </Text>
      {question.status === "pending" ? (
        <Text testID="async-question-answer-later-hint" style={styles.body}>
          {t("task.async_question.answer_later_hint")}
        </Text>
      ) : null}
      {question.status === "delivery_failed" && question.deliveryError ? (
        <Text testID="async-question-delivery-error" accessibilityRole="alert" style={styles.responseError}>
          {question.deliveryError}
        </Text>
      ) : null}
      {listError ? (
        <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={[styles.responseError, styles.flex]}>
            {t("task.async_question.refresh_failed", { p0: listError })}
          </Text>
          <Button testID="async-question-refresh" variant="ghost" onPress={onRefresh}>
            {t("task.async_question.refresh")}
          </Button>
        </View>
      ) : null}
      {question.status === "pending" ? (
        <QuestionAnswerFields
          questions={formQuestions}
          selected={selected}
          freeform={freeform}
          disabled={disabled || busy || submitting}
          testIdPrefix={`async-question-${question.questionId}`}
          onToggle={(questionId, value, multi) => setSelected((current) => {
            if (!multi) return withAnswer(current, questionId, [value]);
            const values = ownAnswer(current, questionId) ?? [];
            return withAnswer(current, questionId, values.includes(value)
              ? values.filter((item) => item !== value)
              : [...values, value]);
          })}
          onFreeformChange={(questionId, value) => setFreeform((current) => withAnswer(current, questionId, value))}
        />
      ) : question.answer ? (
        <AsyncQuestionAnswerSummary question={question} />
      ) : null}
      {currentResponseFailure ? (
        <Text testID="async-question-response-error" accessibilityRole="alert"
          accessibilityLiveRegion="assertive" style={styles.responseError}>
          {t("task.async_question.answer_failed", { p0: currentResponseFailure })}
        </Text>
      ) : null}
      {question.status === "pending" ? (
        <>
          <Button testID={`async-question-submit-${question.questionId}`} variant="primary"
            disabled={disabled || busy || submitting || !canAnswer} onPress={() => void submit()}>
            {submitting || busy ? t("task.submitting") : t("task.submit_answers")}
          </Button>
          <Button testID={`async-question-cancel-${question.questionId}`} variant="ghost"
            disabled={disabled || busy || submitting} onPress={() => void cancel()}>
            {t("task.async_question.cancel")}
          </Button>
        </>
      ) : canContinueDelivery ? (
        <>
          <Button testID={`async-question-continue-delivery-${question.questionId}`} variant="primary"
            disabled={disabled || busy || submitting} onPress={() => void continueDelivery()}>
            {submitting || busy
              ? t("task.async_question.continuing_delivery")
              : t("task.async_question.continue_delivery")}
          </Button>
          {listError ? (
            <Button testID={`async-question-check-${question.questionId}`} variant="ghost" onPress={onRefresh}>
              {t("task.async_question.refresh")}
            </Button>
          ) : null}
        </>
      ) : question.status === "delivery_unknown" || listError ? (
        <Button testID={`async-question-check-${question.questionId}`} variant="ghost" onPress={onRefresh}>
          {t("task.async_question.refresh")}
        </Button>
      ) : null}
    </View>
  );
}

export function AsyncQuestionListError({
  error,
  onRefresh,
}: {
  error: string;
  onRefresh(): void;
}) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID="async-question-list-error" style={[styles.card, styles.asyncQuestionListError]}>
      <Text accessibilityRole="alert" style={styles.responseError}>
        {t("task.async_question.refresh_failed", { p0: error })}
      </Text>
      <Button testID="async-question-list-retry" variant="ghost" onPress={onRefresh}>
        {t("task.async_question.refresh")}
      </Button>
    </View>
  );
}

function AsyncQuestionAnswerSummary({ question }: { question: AsyncQuestionRecord }) {
  const styles = useThemedStyles(makeStyles);
  const answers = question.answer?.answers ?? {};
  return (
    <View testID="async-question-authoritative-answer" style={styles.interactionScrollContent}>
      {question.questions.map((item) => {
        const answer = ownAnswer(answers, item.id);
        if (!answer) return null;
        const labels = (answer.selectedOptionIds ?? []).map((id) =>
          item.options.find((option) => option.id === id)?.label,
        ).filter((label): label is string => Boolean(label));
        const parts = [...labels, ...(answer.text ? [answer.text] : [])];
        return (
          <View key={item.id} style={styles.question}>
            <Text style={styles.questionHeader}>{item.header}</Text>
            <Text style={styles.body}>{item.question}</Text>
            <Text style={styles.answerText}>{parts.join(", ")}</Text>
          </View>
        );
      })}
    </View>
  );
}

function createAsyncQuestionSubmissionId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `mobile-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function runInteractionResponse(
  requestId: number,
  identity: string,
  label: string,
  send: () => void,
  setFailure: (
    failure: { identity: string; requestId: number; message: string } | null,
  ) => void,
): string | null {
  try {
    send();
    setFailure(null);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${label} failed: ${detail}. You can try again.`;
    setFailure({ identity, requestId, message });
    return message;
  }
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    maxHeight: "62%",
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    gap: spacing.md,
  },
  asyncQuestionCard: { maxHeight: undefined, marginHorizontal: 0, marginBottom: 0 },
  asyncQuestionListError: { maxHeight: undefined },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
  status: { fontSize: 13, lineHeight: 19, fontWeight: "600" },
  answerText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  codeBox: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  unsafeApproval: { color: colors.red, fontSize: 12, lineHeight: 18 },
  responseError: { color: colors.red, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", gap: spacing.sm },
  errorRow: { gap: spacing.sm },
  flex: { flex: 1 },
  compactButton: { flex: 1, paddingHorizontal: spacing.xs },
  interactionScroll: { flexShrink: 1 },
  interactionScrollContent: { gap: spacing.md },
  question: { gap: spacing.sm },
  questionHeader: {
    color: colors.blue,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionSelected: {
    borderColor: colors.blue,
    backgroundColor: "rgba(96,165,250,0.1)",
  },
  optionLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  optionDescription: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  input: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
});
