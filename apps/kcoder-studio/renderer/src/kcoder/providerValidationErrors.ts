const categories = new Set([
  'authentication',
  'permission',
  'quota',
  'rate_limit',
  'model',
  'timeout',
  'network',
  'response',
  'configuration',
  'changed',
  'busy',
  'unsupported',
])

/** Transport failures cannot prove whether the target committed the mutation. */
export function providerSaveOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  // A probe refusal happens before the configuration transaction is committed.
  if (/\[provider_probe_[a-z_]+\]/.test(error.message)) return false
  const reason = (error as Error & { reason?: string }).reason
  return reason === 'connection' ||
    error.message.includes('[provider_transaction_pending]') ||
    /timed?\s*out|timeout|连接已断开/i.test(error.message)
}

export function providerSaveErrorKey(error: unknown): string {
  if (error instanceof Error && error.message.includes('[provider_transaction_pending]')) return 'providerSettings.transactionPending'
  if (error instanceof Error && error.message.includes('[provider_reasoning_policy]')) return 'localRuntime:providerSettings.reasoningPolicyConflict'
  const category =
    error instanceof Error ? /\[provider_probe_([a-z_]+)\]/.exec(error.message)?.[1] : null
  return category && categories.has(category)
    ? `providerSettings.validation_${category}`
    : 'providerSettings.saveFailed'
}
