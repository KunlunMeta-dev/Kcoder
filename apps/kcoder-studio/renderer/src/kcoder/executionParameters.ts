function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function executionReasoningEffort(execution: Record<string, unknown>): string | null {
  const modelConfig = record(execution.model_config)
  return (
    text(record(modelConfig.reasoning).effort) ?? text(record(execution.reasoning_config).effort)
  )
}

export function executionServiceTier(execution: Record<string, unknown>): string | null {
  return text(record(execution.model_config).service_tier)
}

export function executionSelectedModel(
  execution: Record<string, unknown>,
  modelSelection: Record<string, unknown>
): string | null {
  const modelConfig = record(execution.model_config)
  const model = text(modelConfig.model_id) ?? text(modelSelection.modelName)
  const provider =
    text(modelSelection.providerId) ??
    text(record(modelSelection.options).codexProviderId) ??
    text(record(modelSelection.options).codex_model_provider) ??
    text(modelConfig.model_provider) ??
    text(modelConfig.modelProvider)
  // Keep explicit selectors intact, including legacy selections already qualified upstream.
  return model ? (provider && !model.includes('::') ? `${provider}::${model}` : model) : provider
}
