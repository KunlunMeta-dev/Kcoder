import type { ContextPreflightFailure } from './generated/contracts'

const categories = [
  'authentication_error',
  'forbidden',
  'model_or_route',
  'invalid_parameter',
  'context_length_exceeded',
  'quota_exceeded',
  'rate_limit',
  'network_error',
  'timeout_error',
  'model_protocol_error',
  'provider_error',
] as const

export interface ProviderFailureDetails {
  category: (typeof categories)[number]
  recovery_action: 'needs_human' | 'diagnose_only'
  http_status?: number | null
  retryable: boolean
  resume_safe: boolean
  retry_after_ms?: number | null
  context_preflight?: ContextPreflightFailure & {
    continuation_available: boolean
  }
}

export function decodeProviderFailure(value: unknown): ProviderFailureDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  if (
    !categories.includes(data.category as ProviderFailureDetails['category']) ||
    !['needs_human', 'diagnose_only'].includes(data.recovery_action as string) ||
    typeof data.retryable !== 'boolean' ||
    typeof data.resume_safe !== 'boolean'
  )
    return undefined
  if (
    (data.resume_safe && !data.retryable) ||
    (data.recovery_action === 'needs_human' && (data.retryable || data.resume_safe))
  )
    return undefined
  for (const [key, min, max] of [
    ['http_status', 100, 999],
    ['retry_after_ms', 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const number = data[key]
    if (
      number !== undefined &&
      number !== null &&
      (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max)
    )
      return undefined
  }
  let context: ProviderFailureDetails['context_preflight']
  if (data.context_preflight !== undefined && data.context_preflight !== null) {
    const value = data.context_preflight as Record<string, unknown>
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      data.category !== 'context_length_exceeded' ||
      !Number.isSafeInteger(value.request_tokens) ||
      Number(value.request_tokens) < 0 ||
      !Number.isSafeInteger(value.input_limit_tokens) ||
      Number(value.input_limit_tokens) < 0 ||
      typeof value.count_is_exact !== 'boolean' ||
      typeof value.continuation_available !== 'boolean' ||
      !['fixed_overhead_exceeds_limit', 'disabled_by_policy', 'still_over_limit', 'no_compactable_history', 'failed'].includes(
        String(value.compaction)
      )
    )
      return undefined
    context = {
      request_tokens: value.request_tokens as number,
      input_limit_tokens: value.input_limit_tokens as number,
      count_is_exact: value.count_is_exact,
      compaction: value.compaction as NonNullable<
        ProviderFailureDetails['context_preflight']
      >['compaction'],
      continuation_available: value.continuation_available,
    }
  }
  return {
    category: data.category as ProviderFailureDetails['category'],
    recovery_action: data.recovery_action as ProviderFailureDetails['recovery_action'],
    retryable: data.retryable,
    resume_safe: data.resume_safe,
    ...(data.http_status !== undefined ? { http_status: data.http_status as number | null } : {}),
    ...(data.retry_after_ms !== undefined
      ? { retry_after_ms: data.retry_after_ms as number | null }
      : {}),
    ...(context ? { context_preflight: context } : {}),
  }
}

/** Choosing a model is safe without a checkpoint; continuing a failed turn is not. */
export function contextPreflightRecovery(input: {
  providerFailure?: unknown
  error?: string
}): 'continue' | 'select_model' | undefined {
  const context = decodeProviderFailure(input.providerFailure)?.context_preflight
  if (context) return context.continuation_available ? 'continue' : 'select_model'
  // Old diagnostics can suppress replay, never grant continuation authority.
  return input.error?.includes('Context request blocked before sending:')
    ? 'select_model'
    : undefined
}
