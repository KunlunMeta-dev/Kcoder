import { t } from "@/i18n";
import { providerFailureSummary } from "./provider-failure-presentation";
import { failureRecoveryFacts } from "../../../shared/failureRecoveryFacts";
import { decodeProviderFailure } from "../../../shared/providerFailure";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatMessage, TaskRuntime } from "@/runtime/task-runtime";
import { useLocale } from "@/i18n/use-locale";
import { useThemedStyles, type ThemeColors } from "@/theme";

export function FailureContinuation({
  task,
  message,
  busy,
  connected,
}: {
  task: TaskRuntime;
  message: ChatMessage;
  busy: boolean;
  connected: boolean;
}) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const [error, setError] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const state = task.continuationState(message.id);
  const providerFailure = decodeProviderFailure(message.providerFailure);
  const facts = failureRecoveryFacts({ ...message, providerFailure });
  const recoveryFacts = (
    <View testID="failure-recovery-facts" style={styles.container}>
      <Text testID="failure-summary" style={styles.error}>
        {providerFailureSummary(providerFailure)}
      </Text>
      {message.error ? (
        <Pressable
          testID="failure-technical-details"
          accessibilityRole="button"
          accessibilityState={{ expanded: detailsVisible }}
          onPress={() => setDetailsVisible((value) => !value)}
          style={styles.button}
        >
          <Text style={styles.label}>
            {detailsVisible
              ? t("task.hide_technical_details")
              : t("task.view_technical_details")}
          </Text>
        </Pressable>
      ) : null}
      {detailsVisible ? (
        <Text selectable style={styles.note}>
          {message.error}
        </Text>
      ) : null}
      <Text style={styles.note}>
        {t("task.failure_phase")}
        {facts.phase === "model_request"
          ? t("task.model_request")
          : facts.phase === "runtime"
            ? t("task.runtime")
            : t("task.unknown")}
      </Text>
      <Text style={styles.note}>
        {facts.committedStepsPreserved
          ? t(
              "task.confirmed_committed_steps_are_preserved_uncommitted_execution_results",
            )
          : t("task.this_record_has_no_confirmed_step_boundary_yet")}
      </Text>
      <Text style={styles.note}>
        {t("task.the_server_verifies_the_recovery_boundary_before_continuing")}
      </Text>
    </View>
  );
  const disabled = busy || !connected || !state.allowed;
  const run = async (selectedModel = false) => {
    setError(null);
    try {
      await task.continueFailed(message.id, selectedModel);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  if (message.continuedByAttemptId)
    return (
      <View>
        {recoveryFacts}
        <Text style={styles.note}>
          {t("task.continued_from_the_failure_the_original_record_is")}
        </Text>
      </View>
    );
  return (
    <View style={styles.container}>
      {recoveryFacts}
      <Text style={styles.note}>
        {state.unknown
          ? t("task.the_previous_result_is_unconfirmed_checking_only_reads")
          : t(
              "task.continue_from_the_confirmed_recovery_point_without_resubmitting",
            )}
      </Text>
      {state.reason ? (
        <Text testID="continuation-unavailable" style={styles.note}>
          {state.reason}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          testID="message-continue-failure"
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void run()}
          style={[styles.button, disabled && styles.disabled]}
        >
          <Text style={styles.label}>
            {state.unknown
              ? t("task.check_execution_status")
              : busy
                ? t("task.continuing")
                : t("task.continue_after_failure")}
          </Text>
        </Pressable>
        {!state.unknown &&
        message.attemptId &&
        task.getSnapshot().model &&
        task.supportsCurrentConfigurationContinuation() ? (
          <Pressable
            testID="message-continue-selected-model"
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => void run(true)}
            style={[styles.button, disabled && styles.disabled]}
          >
            <Text style={styles.label}>
              {t("task.continue_with_current_configuration")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text
          testID="continuation-error"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { gap: 8, marginTop: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
  },
  label: { color: colors.text, fontSize: 13 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.5 },
});
