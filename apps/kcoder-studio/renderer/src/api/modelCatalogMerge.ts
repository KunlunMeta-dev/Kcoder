import type { UnifiedModel } from '@/types/api'

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isRuntimeCodexModel(model: UnifiedModel): boolean {
  const config = recordValue(model.config)
  const ui = recordValue(config.ui)
  return (
    model.type === 'runtime' &&
    (config.weworkModelKind === 'codex-official' ||
      config.weworkModelKind === 'codex-provider' ||
      ui.family === 'codex-official' ||
      ui.family === 'codex-provider' ||
      (typeof ui.family === 'string' && ui.family.startsWith('codex-provider:')))
  )
}

function normalizedModelId(model: UnifiedModel): string {
  return model.modelId?.trim().toLowerCase() || ''
}

function canonicalModelKey(model: UnifiedModel): string {
  return [
    model.type,
    model.name.trim().toLowerCase(),
    model.namespace?.trim().toLowerCase() ?? '',
    model.resourceUserId ?? '',
  ].join(':')
}

export function mergeModelCatalogs(
  localModels: UnifiedModel[],
  cloudModels: UnifiedModel[]
): UnifiedModel[] {
  const localCodexModelIds = new Set(
    localModels.filter(isRuntimeCodexModel).map(normalizedModelId).filter(Boolean)
  )
  const seenModelKeys = new Set(localModels.map(canonicalModelKey))
  const uniqueCloudModels = cloudModels.filter(model => {
    const key = canonicalModelKey(model)
    if (seenModelKeys.has(key)) return false
    if (
      isRuntimeCodexModel(model) &&
      normalizedModelId(model) &&
      localCodexModelIds.has(normalizedModelId(model))
    ) {
      return false
    }
    seenModelKeys.add(key)
    return true
  })
  return [...localModels, ...uniqueCloudModels]
}
