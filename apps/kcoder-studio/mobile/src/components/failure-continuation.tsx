import { t } from '@/i18n';
import { providerFailureSummary } from './provider-failure-presentation';
import { runtimeErrorSummary } from './runtime-error';
import { messageProviderRetries, providerRetryCount } from './provider-retry-presentation';
import { failureRecoveryFacts } from '../../../shared/failureRecoveryFacts';
import { decodeProviderFailure } from '../../../shared/providerFailure';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage, TaskRuntime } from '@/runtime/task-runtime';
import { useLocale } from '@/i18n/use-locale';
import { useThemedStyles, type ThemeColors } from '@/theme';

export function FailureContinuation({ task, message, busy, connected, readOnly = false }: {
  task?: TaskRuntime; message: ChatMessage; busy: boolean; connected: boolean; readOnly?: boolean;
}) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const [error, setError] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const state = !readOnly && task ? task.continuationState(message.id) : { allowed: false, unknown: false };
  const providerFailure = decodeProviderFailure(message.providerFailure);
  const facts = failureRecoveryFacts({ ...message, providerFailure });
  const retries = messageProviderRetries(message);
  const retryCount = providerRetryCount(retries);
  const continued = Boolean(message.continuedByAttemptId);
  const details = <View testID="failure-recovery-facts" style={styles.details}>
    {message.error ? <Text selectable style={styles.note}>{message.error}</Text> : null}
    {providerFailure?.http_status ? <Text selectable style={styles.note}>HTTP {providerFailure.http_status}</Text> : null}
    {retries.map(activity => <Text key={activity.id} selectable style={styles.note}>{activity.detail ?? activity.label}</Text>)}
    <Text style={styles.note}>{t('task.failure_phase')}{facts.phase === 'model_request' ? t('task.model_request') : facts.phase === 'runtime' ? t('task.runtime') : t('task.unknown')}</Text>
    <Text style={styles.note}>{facts.committedStepsPreserved ? t('task.confirmed_committed_steps_are_preserved_uncommitted_execution_results') : t('task.this_record_has_no_confirmed_step_boundary_yet')}</Text>
    <Text style={styles.note}>{t('task.the_server_verifies_the_recovery_boundary_before_continuing')}</Text>
    {continued ? <Text style={styles.note}>{t('task.continued_from_the_failure_the_original_record_is')}</Text> : null}
  </View>;
  const disabled = readOnly || !task || busy || !connected || !state.allowed;
  const run = async (selectedModel = false) => {
    if (disabled || !task) return;
    setError(null);
    try { await task.continueFailed(message.id, selectedModel); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  if (continued) return <View testID="continued-failure-history">
    <Pressable testID="continued-failure-toggle" accessibilityRole="button" accessibilityState={{ expanded: historyExpanded }}
      onPress={() => setHistoryExpanded(value => !value)} style={styles.historyToggle}>
      <Text style={styles.note}>{t('task.previous_failure_continued')}</Text>
      <Text style={styles.note}>{t(historyExpanded ? 'task.hide_technical_details' : 'task.view_technical_details')}</Text>
    </Pressable>
    {historyExpanded ? details : null}
  </View>;
  return <View style={styles.container}>
    <View style={styles.summaryRow}>
      <View style={styles.summaryCopy}>
        <Text testID="failure-summary" style={styles.error}>{providerFailure ? providerFailureSummary(providerFailure) : message.error ? runtimeErrorSummary(message.error) : providerFailureSummary(providerFailure)}</Text>
        {retryCount ? <Text testID="failure-retry-count" style={styles.note}>{t('task.provider_retry_history', { count: retryCount })}</Text> : null}
      </View>
      <Pressable testID="failure-technical-details" accessibilityRole="button" accessibilityState={{ expanded: detailsVisible }}
        onPress={() => setDetailsVisible(value => !value)} style={styles.detailsToggle}>
        <Text style={styles.note}>{t(detailsVisible ? 'task.hide_technical_details' : 'task.view_technical_details')}</Text>
      </Pressable>
    </View>
    {detailsVisible ? details : null}
    {!readOnly && task ? <>
      {detailsVisible || state.unknown ? <Text style={styles.note}>{state.unknown ? t('task.the_previous_result_is_unconfirmed_checking_only_reads') : t('task.continue_from_the_confirmed_recovery_point_without_resubmitting')}</Text> : null}
      {state.reason ? <Text testID="continuation-unavailable" style={styles.note}>{state.reason}</Text> : null}
      {providerFailure || state.unknown ? <View style={styles.actions}>
        <Pressable testID="message-continue-failure" accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
          onPress={() => void run()} style={[styles.button, disabled && styles.disabled]}>
          <Text style={styles.label}>{state.unknown ? t('task.check_execution_status') : busy ? t('task.continuing') : t('task.continue_after_failure')}</Text>
        </Pressable>
        {!state.unknown && message.attemptId && task.getSnapshot().model && task.supportsCurrentConfigurationContinuation() ?
          <Pressable testID="message-continue-selected-model" accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
            onPress={() => void run(true)} style={[styles.button, disabled && styles.disabled]}>
            <Text style={styles.label}>{t('task.continue_with_current_configuration')}</Text>
          </Pressable> : null}
      </View> : null}
    </> : null}
    {error ? <Text testID="continuation-error" accessibilityRole="alert" style={styles.error}>{runtimeErrorSummary(error)}</Text> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: { gap: 8, marginTop: 8 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  summaryCopy: { flexGrow: 1, flexShrink: 1, minWidth: 160 },
  detailsToggle: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  historyToggle: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  details: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  label: { color: colors.text, fontSize: 13 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.5 },
});
