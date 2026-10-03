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
import { colors, radius, spacing } from "@/theme";
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
  const available = interaction.availableDecisions ?? [
    "accept",
    "accept_for_session",
    "decline",
    "cancel",
  ];
  const action = approvalActionPresentation(interaction.action);
  return (
    <View testID="approval-card" style={styles.card}>
      <View style={styles.titleRow}>
        <ShieldCheck size={20} color={colors.yellow} />
        <Text style={styles.title}>
          Approval required
          {pendingCount > 1 ? ` · ${pendingCount} pending` : ""}
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
            The operation input cannot be displayed completely and safely, so
            the client disabled approval. Decline or cancel the request.
          </Text>
        ) : null}
      </ScrollView>
      {available.includes("decline") ||
      available.includes("accept_for_session") ? (
        <View style={styles.row}>
          {available.includes("decline") ? (
            <Button
              testID="approval-decline"
              disabled={interaction.responding}
              style={styles.flex}
              onPress={() => onRespond("decline")}
            >
              Decline
            </Button>
          ) : null}
          {available.includes("accept_for_session") ? (
            <Button
              testID="approval-accept-session"
              disabled={interaction.responding || !action.safeToApprove}
              style={styles.compactButton}
              onPress={() => onRespond("accept_for_session")}
            >
              Allow for session
            </Button>
          ) : null}
        </View>
      ) : null}
      {available.includes("accept") ? (
        <Button
          testID="approval-accept"
          disabled={interaction.responding || !action.safeToApprove}
          variant="primary"
          onPress={() => onRespond("accept")}
        >
          {interaction.responding
            ? "Submitting…"
            : action.safeToApprove
              ? "Allow once"
              : "Incomplete input; approval disabled"}
        </Button>
      ) : null}
      {available.includes("cancel") ? (
        <Button
          testID="approval-cancel"
          disabled={interaction.responding}
          variant="ghost"
          onPress={() => onRespond("cancel")}
        >
          Cancel request
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
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
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

  return (
    <View testID="question-card" style={styles.card}>
      <View style={styles.titleRow}>
        <HelpCircle size={20} color={colors.blue} />
        <Text style={styles.title}>
          KCoder has questions
          {pendingCount > 1 ? ` · ${pendingCount} pending` : ""}
        </Text>
      </View>
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
                accessibilityLabel={`Other answer for ${question.header}`}
                placeholder="Enter another answer…"
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
      <Button
        testID="question-submit"
        variant="primary"
        disabled={
          interaction.responding ||
          interaction.questions.some(
            (question) => !(answers[question.id]?.length > 0),
          )
        }
        onPress={() => onSubmit(answers)}
      >
        {interaction.responding ? "Submitting…" : "Submit answers"}
      </Button>
      <Button
        testID="question-cancel"
        variant="ghost"
        disabled={interaction.responding}
        onPress={onCancel}
      >
        Cancel questions
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
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
