import { providerFailureSummary } from './provider-failure-presentation';
import { failureRecoveryFacts } from '../../../shared/failureRecoveryFacts';
import { decodeProviderFailure } from '../../../shared/providerFailure';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage, TaskRuntime } from '@/runtime/task-runtime';
import { colors } from '@/theme';

export function FailureContinuation({ task, message, busy, connected }: {
  task: TaskRuntime; message: ChatMessage; busy: boolean; connected: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const state = task.continuationState(message.id);
  const providerFailure = decodeProviderFailure(message.providerFailure);
  const facts = failureRecoveryFacts({ ...message, providerFailure });
  const recoveryFacts = <View testID="failure-recovery-facts" style={styles.container}>
    <Text testID="failure-summary" style={styles.error}>{providerFailureSummary(providerFailure)}</Text>
    {message.error ? <Pressable testID="failure-technical-details" accessibilityRole="button" accessibilityState={{ expanded: detailsVisible }}
      onPress={() => setDetailsVisible(value => !value)} style={styles.button}>
      <Text style={styles.label}>{detailsVisible ? '收起技术详情' : '查看技术详情'}</Text>
    </Pressable> : null}
    {detailsVisible ? <Text selectable style={styles.note}>{message.error}</Text> : null}
    <Text style={styles.note}>失败阶段：{facts.phase === 'model_request' ? '模型请求' : facts.phase === 'runtime' ? '运行时' : '尚未确定'}</Text>
    <Text style={styles.note}>{facts.committedStepsPreserved ? '已确认提交的步骤会保留；未提交的执行结果仍需核实。' : '此记录尚未提供可确认的步骤边界，执行结果仍需核实。'}</Text>
    <Text style={styles.note}>继续前，服务器会核验恢复边界；结果未确认的操作不会自动重放。</Text>
  </View>;
  const disabled = busy || !connected || !state.allowed;
  const run = async (selectedModel = false) => {
    setError(null);
    try { await task.continueFailed(message.id, selectedModel); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  if (message.continuedByAttemptId) return <View>{recoveryFacts}<Text style={styles.note}>已从失败处继续，原记录已保留。</Text></View>;
  return <View style={styles.container}>
    {recoveryFacts}
    <Text style={styles.note}>{state.unknown ? '上次请求的结果尚未确认；核对只读取状态，不重复执行。' : '继续使用已确认的恢复点，不重新提交原消息。'}</Text>
    {state.reason ? <Text testID="continuation-unavailable" style={styles.note}>{state.reason}</Text> : null}
    <View style={styles.actions}>
      <Pressable testID="message-continue-failure" accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
        onPress={() => void run()} style={[styles.button, disabled && styles.disabled]}>
        <Text style={styles.label}>{state.unknown ? '核对执行状态' : busy ? '正在继续…' : '从失败处继续'}</Text>
      </Pressable>
      {!state.unknown && message.attemptId && task.getSnapshot().model && task.supportsCurrentConfigurationContinuation() ? <Pressable testID="message-continue-selected-model" accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
        onPress={() => void run(true)} style={[styles.button, disabled && styles.disabled]}>
        <Text style={styles.label}>使用当前配置继续</Text>
      </Pressable> : null}
    </View>
    {error ? <Text testID="continuation-error" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 8, marginTop: 8 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  label: { color: colors.text, fontSize: 13 }, note: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 }, disabled: { opacity: 0.5 },
});
