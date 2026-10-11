import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useEffect, useMemo, useState } from "react";
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
  ApprovalInteraction,
  QuestionInteraction,
} from "@/runtime/task-runtime";
import { Button } from "./ui";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { approvalActionPresentation } from "./approval-action";

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
    requestId: number;
    message: string;
  } | null>(null);
  const available = interaction.availableDecisions ?? [
    "accept",
    "accept_for_session",
    "decline",
    "cancel",
  ];
  const action = approvalActionPresentation(interaction.action);
  const responseError =
    responseFailure?.requestId === interaction.requestId
      ? responseFailure.message
      : null;
  const respond = (decision: Parameters<typeof onRespond>[0]) =>
    runInteractionResponse(
      interaction.requestId,
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
  pendingCount = 1,
}: {
  interaction: QuestionInteraction;
  pendingCount?: number;
  onSubmit(answers: Record<string, string[]>): void;
  onCancel(): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [responseFailure, setResponseFailure] = useState<{
    requestId: number;
    message: string;
  } | null>(null);
  useEffect(() => {
    setSelected({});
    setFreeform({});
  }, [interaction.requestId]);
  const answers = useMemo(() => {
    const result = { ...selected };
    for (const [id, value] of Object.entries(freeform)) {
      if (!value.trim()) continue;
      const question = interaction.questions.find((item) => item.id === id);
      result[id] = question?.multiSelect
        ? [...new Set([...(result[id] ?? []), value.trim()])]
        : [value.trim()];
    }
    return result;
  }, [freeform, interaction.questions, selected]);

  const toggle = (questionId: string, value: string, multi: boolean) => {
    setSelected((current) => {
      if (!multi) return { ...current, [questionId]: [value] };
      const values = current[questionId] ?? [];
      return {
        ...current,
        [questionId]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  };
  const responseError =
    responseFailure?.requestId === interaction.requestId
      ? responseFailure.message
      : null;
  const submit = () =>
    runInteractionResponse(
      interaction.requestId,
      "Question response",
      () => onSubmit(answers),
      setResponseFailure,
    );
  const cancel = () =>
    runInteractionResponse(
      interaction.requestId,
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
      <ScrollView
        style={styles.interactionScroll}
        contentContainerStyle={styles.interactionScrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        {interaction.questions.map((question) => (
          <View key={question.id} style={styles.question}>
            <Text style={styles.questionHeader}>{question.header}</Text>
            <Text style={styles.body}>{question.prompt}</Text>
            {question.options.map((option) => {
              const checked = (selected[question.id] ?? []).includes(
                option.value,
              );
              return (
                <Pressable
                  key={option.value}
                  testID={`question-option-${question.id}-${option.value}`}
                  accessibilityRole={
                    question.multiSelect ? "checkbox" : "radio"
                  }
                  accessibilityLabel={
                    option.description
                      ? `${option.label}, ${option.description}`
                      : option.label
                  }
                  accessibilityState={{ checked }}
                  aria-checked={checked}
                  onPress={() =>
                    toggle(question.id, option.value, question.multiSelect)
                  }
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
                      <Text style={styles.optionDescription}>
                        {option.description}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {question.allowsFreeform ? (
              <TextInput
                accessibilityLabel={t("task.other_answer_for", {
                  p0: question.header,
                })}
                placeholder={t("task.enter_another_answer")}
                placeholderTextColor={colors.textDim}
                value={freeform[question.id] ?? ""}
                onChangeText={(value) =>
                  setFreeform((current) => ({
                    ...current,
                    [question.id]: value,
                  }))
                }
                style={styles.input}
              />
            ) : null}
          </View>
        ))}
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
      <Button
        testID="question-submit"
        variant="primary"
        disabled={
          interaction.responding ||
          interaction.questions.some(
            (question) => !(answers[question.id]?.length > 0),
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
        disabled={interaction.responding}
        onPress={cancel}
      >
        {t("task.cancel_questions")}
      </Button>
    </View>
  );
}

function runInteractionResponse(
  requestId: number,
  label: string,
  send: () => void,
  setFailure: (
    failure: { requestId: number; message: string } | null,
  ) => void,
): string | null {
  try {
    send();
    setFailure(null);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${label} failed: ${detail}. You can try again.`;
    setFailure({ requestId, message });
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
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
  codeBox: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  unsafeApproval: { color: colors.red, fontSize: 12, lineHeight: 18 },
  responseError: { color: colors.red, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", gap: spacing.sm },
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
