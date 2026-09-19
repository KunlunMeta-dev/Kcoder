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

export function providerSaveErrorKey(error: unknown): string {
  const category =
    error instanceof Error ? /\[provider_probe_([a-z_]+)\]/.exec(error.message)?.[1] : null
  return category && categories.has(category)
    ? `providerSettings.validation_${category}`
    : 'providerSettings.saveFailed'
}
