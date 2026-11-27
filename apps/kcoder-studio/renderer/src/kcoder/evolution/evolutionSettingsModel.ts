import type { UnifiedModel } from '@/types/api'
import type {
  EvolutionModelRef,
  EvolutionScore,
  EvolutionSettings,
  EvolutionTargetSetting,
  EvolutionTargetType,
} from './evolutionContract'

/** Defaults from plan §15; the target remains authoritative for resolved values. */
export function defaultEvolutionSettings(): EvolutionSettings {
  return {
    enabled: false,
    mode: 'propose',
    targets: {
      skill: { enabled: true, scope: 'all', items: {}, allow_file_edits: false },
      preference: { enabled: true },
      project_knowledge: { enabled: true, mode: 'propose' },
      tool_usage: { enabled: false },
      workflow_template: { enabled: false },
    },
    signals: {
      artifact_edits: true,
      procedure_results: true,
      chat_corrections: true,
      rating_ui: true,
    },
    distill_min_usages: 20,
    candidate_traffic: 0.5,
    promote_threshold: 0.8,
    rollback_threshold: 0.3,
    model: null,
    stage_models: { classifier: null, distill: null, eval: null },
    evidence_ttl_days: 90,
    share_aggregates: false,
    usage_limit: { monthly_max_tokens: null },
    eval: { ...DEFAULT_EVAL },
  }
}

/** Server defaults for `evolution.eval`; an absent object means these apply. */
export const DEFAULT_EVAL = { win_rate: 0.6, max_diversity_drop: 0.1 } as const

export const EVIDENCE_TTL_CHOICES = [30, 90, 180] as const

/** Low / standard / high distillation frequency maps onto `distill_min_usages`. */
export const DISTILL_FREQUENCIES = { low: 50, standard: 20, high: 10 } as const
export type DistillFrequency = keyof typeof DISTILL_FREQUENCIES

export function distillFrequency(minUsages: number): DistillFrequency | 'custom' {
  const entry = Object.entries(DISTILL_FREQUENCIES).find(([, value]) => value === minUsages)
  return entry ? (entry[0] as DistillFrequency) : 'custom'
}

export function targetSetting(
  settings: EvolutionSettings,
  type: EvolutionTargetType
): EvolutionTargetSetting {
  return settings.targets[type] ?? defaultEvolutionSettings().targets[type]
}

/** A target setting may omit `enabled`; the documented default then applies. */
export function targetEnabled(settings: EvolutionSettings, type: EvolutionTargetType): boolean {
  return targetSetting(settings, type).enabled ?? defaultEvolutionSettings().targets[type].enabled === true
}

/** Explicit item choices win; otherwise "all" includes and "selected" excludes. */
export function itemEnabled(settings: EvolutionSettings, type: EvolutionTargetType, key: string) {
  const target = targetSetting(settings, type)
  const explicit = target.items?.[key]?.enabled
  return explicit ?? (target.scope ?? 'all') === 'all'
}

export function withTarget(
  settings: EvolutionSettings,
  type: EvolutionTargetType,
  patch: Partial<EvolutionTargetSetting>
): EvolutionSettings {
  return {
    ...settings,
    targets: { ...settings.targets, [type]: { ...targetSetting(settings, type), ...patch } },
  }
}

export function withItem(
  settings: EvolutionSettings,
  type: EvolutionTargetType,
  key: string,
  enabled: boolean
): EvolutionSettings {
  const target = targetSetting(settings, type)
  return withTarget(settings, type, { items: { ...(target.items ?? {}), [key]: { enabled } } })
}

// ---------- Advanced parameters ----------

export interface AdvancedDraft {
  candidate_traffic: string
  promote_threshold: string
  rollback_threshold: string
  monthly_max_tokens: string
  win_rate: string
  max_diversity_drop: string
}

export type AdvancedField = keyof AdvancedDraft
export type AdvancedError =
  | 'range_fraction'
  | 'range_traffic'
  | 'rollback_not_below'
  | 'positive_integer'
  | 'range_win_rate'
  | 'range_diversity_drop'

export function advancedDraft(settings: EvolutionSettings): AdvancedDraft {
  return {
    candidate_traffic: String(settings.candidate_traffic),
    promote_threshold: String(settings.promote_threshold),
    rollback_threshold: String(settings.rollback_threshold),
    monthly_max_tokens:
      settings.usage_limit.monthly_max_tokens == null
        ? ''
        : String(settings.usage_limit.monthly_max_tokens),
    win_rate: String(settings.eval?.win_rate ?? DEFAULT_EVAL.win_rate),
    max_diversity_drop: String(settings.eval?.max_diversity_drop ?? DEFAULT_EVAL.max_diversity_drop),
  }
}

function fraction(value: string): number | null {
  if (!/^\s*\d*(?:\.\d+)?\s*$/.test(value) || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Range checks run inline; any error blocks saving the advanced group. */
export function validateAdvanced(draft: AdvancedDraft): Partial<Record<AdvancedField, AdvancedError>> {
  const errors: Partial<Record<AdvancedField, AdvancedError>> = {}
  const traffic = fraction(draft.candidate_traffic)
  if (traffic === null || traffic <= 0 || traffic > 1) errors.candidate_traffic = 'range_traffic'
  const promote = fraction(draft.promote_threshold)
  if (promote === null || promote <= 0 || promote > 1) errors.promote_threshold = 'range_fraction'
  const rollback = fraction(draft.rollback_threshold)
  if (rollback === null || rollback < 0 || rollback >= 1) errors.rollback_threshold = 'range_fraction'
  else if (promote !== null && !errors.promote_threshold && rollback >= promote)
    errors.rollback_threshold = 'rollback_not_below'
  const limit = draft.monthly_max_tokens.trim()
  if (limit && (!/^\d+$/.test(limit) || Number(limit) <= 0 || !Number.isSafeInteger(Number(limit))))
    errors.monthly_max_tokens = 'positive_integer'
  // UI ranges are narrower than the server's accepted ranges on purpose.
  const winRate = fraction(draft.win_rate)
  if (winRate === null || winRate < 0.5 || winRate > 1) errors.win_rate = 'range_win_rate'
  const drop = fraction(draft.max_diversity_drop)
  if (drop === null || drop < 0 || drop > 0.5) errors.max_diversity_drop = 'range_diversity_drop'
  return errors
}

export function applyAdvanced(settings: EvolutionSettings, draft: AdvancedDraft): EvolutionSettings {
  const limit = draft.monthly_max_tokens.trim()
  const evaluation = {
    win_rate: Number(draft.win_rate),
    max_diversity_drop: Number(draft.max_diversity_drop),
  }
  // Older targets omit `eval`; keep it absent unless the user changed a value.
  const keepAbsent =
    settings.eval == null &&
    evaluation.win_rate === DEFAULT_EVAL.win_rate &&
    evaluation.max_diversity_drop === DEFAULT_EVAL.max_diversity_drop
  return {
    ...settings,
    candidate_traffic: Number(draft.candidate_traffic),
    promote_threshold: Number(draft.promote_threshold),
    rollback_threshold: Number(draft.rollback_threshold),
    usage_limit: { monthly_max_tokens: limit ? Number(limit) : null },
    ...(keepAbsent ? {} : { eval: evaluation }),
  }
}

/** "Restore defaults" covers the advanced group only, including per-stage models. */
export function restoreAdvancedDefaults(settings: EvolutionSettings): EvolutionSettings {
  const defaults = defaultEvolutionSettings()
  return {
    ...settings,
    candidate_traffic: defaults.candidate_traffic,
    promote_threshold: defaults.promote_threshold,
    rollback_threshold: defaults.rollback_threshold,
    stage_models: defaults.stage_models,
    usage_limit: defaults.usage_limit,
    ...(settings.eval == null ? {} : { eval: { ...DEFAULT_EVAL } }),
  }
}

// ---------- Model choices ----------

export interface ConfiguredModelOption {
  value: string
  ref: EvolutionModelRef
  label: string
  available: boolean
}

export const FOLLOW_SESSION_VALUE = 'follow_session'
export const SAME_AS_MAIN_VALUE = 'same_as_main'

/** Encodes a reference without lowercasing or joining ambiguous separators. */
export function modelRefValue(ref: EvolutionModelRef): string {
  return JSON.stringify([ref.provider, ref.model])
}

export function parseModelRefValue(value: string): EvolutionModelRef | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[0] &&
      parsed[1]
    )
      return { provider: parsed[0], model: parsed[1] }
  } catch {
    // Non-model sentinel values are handled by the caller.
  }
  return null
}

function configString(model: UnifiedModel, key: string): string | null {
  const value = model.config?.[key]
  return typeof value === 'string' && value ? value : null
}

/**
 * Exactly the models the session picker can choose on this target: catalog
 * entries that carry a configured provider and model identity. Placeholder rows
 * (for example "no model available") have no model ID and are excluded.
 */
export function configuredModelOptions(models: UnifiedModel[]): ConfiguredModelOption[] {
  const seen = new Set<string>()
  const options: ConfiguredModelOption[] = []
  for (const model of models) {
    const provider = configString(model, 'codexProviderId')
    const modelId = typeof model.modelId === 'string' && model.modelId ? model.modelId : null
    if (!provider || !modelId) continue
    const ref = { provider, model: modelId }
    const value = modelRefValue(ref)
    if (seen.has(value)) continue
    seen.add(value)
    const providerName = configString(model, 'codexProviderName') ?? provider
    options.push({
      value,
      ref,
      label: `${model.displayName || modelId} · ${providerName}`,
      available: model.compatibilityDisabled !== true && model.isActive !== false,
    })
  }
  return options
}

export function sameModelRef(left: EvolutionModelRef | null, right: EvolutionModelRef | null) {
  return left?.provider === right?.provider && left?.model === right?.model
}

/** A stored reference that is no longer configured or usable pauses model calls. */
export function isModelMissing(value: EvolutionModelRef | null, options: ConfiguredModelOption[]) {
  if (!value) return false
  const match = options.find(option => option.value === modelRefValue(value))
  return !match || !match.available
}

/** Posterior mean with its credible interval, e.g. "72% (61%–80%)". */
export function formatScore(score: EvolutionScore, locale?: string) {
  const format = (value: number) =>
    value.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 })
  return `${format(score.mean)} (${format(score.lower)}–${format(score.upper)})`
}
