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
  return {
    category: data.category as ProviderFailureDetails['category'],
    recovery_action: data.recovery_action as ProviderFailureDetails['recovery_action'],
    retryable: data.retryable,
    resume_safe: data.resume_safe,
    ...(data.http_status !== undefined ? { http_status: data.http_status as number | null } : {}),
    ...(data.retry_after_ms !== undefined
      ? { retry_after_ms: data.retry_after_ms as number | null }
      : {}),
  }
}
