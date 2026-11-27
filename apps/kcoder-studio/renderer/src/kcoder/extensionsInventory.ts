import { requestLocalExecutor } from '@/host/localExecutor'
import { isContract } from '../../../shared/generated/validator.mjs'
import type {
  ExtensionConflict,
  ExtensionConflictsPreviewParams,
  ExtensionConflictsPreviewResult,
  ExtensionInventoryItem,
  ExtensionLayer,
  ExtensionPluginSkillsResult,
  ExtensionSkillPreference,
  ExtensionSkillPreferenceResult,
  ExtensionsInventoryResult,
} from '../../../shared/generated/contracts'

export type {
  ExtensionConflict,
  ExtensionConflictsPreviewResult,
  ExtensionHookIssue,
  ExtensionInventoryItem,
  ExtensionLayer,
  ExtensionSkillPreference,
  ExtensionSourceRef,
  ExtensionUpstream,
  ExtensionsInventoryResult,
} from '../../../shared/generated/contracts'

/** Capability a target must advertise before any `extensions/*` request. */
export const EXTENSIONS_INVENTORY_CAPABILITY = 'extensionsInventoryV1'
/** Capability a target must advertise before `plugin/skills/setEnabled`. */
export const PLUGIN_SKILL_POLICY_CAPABILITY = 'pluginSkillPolicyV1'

export type ExtensionsFailureKind =
  | 'unsupported'
  | 'preference_conflict'
  | 'skill_switch_conflict'
  | 'invalid'
  | 'scope_changed'
  | 'unconfirmed'
  | 'unavailable'

export class ExtensionsRequestError extends Error {
  readonly kind: ExtensionsFailureKind
  constructor(kind: ExtensionsFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExtensionsRequestError'
    this.kind = kind
  }
}

/** Classify a Gateway failure without echoing arbitrary remote data. */
export function extensionsFailureKind(error: unknown, writing = false): ExtensionsFailureKind {
  if (error instanceof ExtensionsRequestError) return error.kind
  const failure = error as {
    code?: unknown
    reason?: unknown
    data?: { kind?: unknown }
  } | null
  const kind = failure?.data?.kind
  if (kind === 'plugin_update_required' || failure?.code === -32601) return 'unsupported'
  if (kind === 'skill_preference_conflict') return 'preference_conflict'
  if (kind === 'plugin_skill_policy_conflict') return 'skill_switch_conflict'
  if (kind === 'plugin_scope_changed') return 'scope_changed'
  if (kind === 'extensions_invalid' || failure?.code === -32602) return 'invalid'
  // A write whose receipt was lost may still have been applied.
  if (writing && (failure?.reason === 'timeout' || failure?.reason === 'connection'))
    return 'unconfirmed'
  return 'unavailable'
}

export interface ExtensionsTarget {
  deviceId?: string
  workspacePath?: string
  isScopeCurrent?: () => boolean
}

export interface ExtensionsApi {
  /** Never pass `includeBinaries` from polling or automatic refresh paths. */
  inventory(options?: { includeBinaries?: boolean }): Promise<ExtensionsInventoryResult>
  updateSkillPreference(
    expectedRevision: string,
    preference: ExtensionSkillPreference
  ): Promise<ExtensionSkillPreferenceResult>
  previewConflicts(
    params: ExtensionConflictsPreviewParams
  ): Promise<ExtensionConflictsPreviewResult>
  /** Turns only this plugin's skill copies on or off; requires `pluginSkillPolicyV1`. */
  setPluginSkillsEnabled(
    pluginId: string,
    enabled: boolean,
    expectedRevision: string
  ): Promise<ExtensionPluginSkillsResult>
}

export function createExtensionsApi(target: ExtensionsTarget = {}): ExtensionsApi {
  const { isScopeCurrent, ...scope } = target
  const assertScope = () => {
    if (isScopeCurrent && !isScopeCurrent())
      throw new ExtensionsRequestError('scope_changed', 'Plugin target or account changed')
  }
  const request = async (
    method: string,
    params: Record<string, unknown>,
    contract: string,
    writing = false
  ) => {
    assertScope()
    let result: unknown
    try {
      result = await requestLocalExecutor('runtime.plugins.request', { ...scope, method, params })
    } catch (error) {
      throw new ExtensionsRequestError(
        extensionsFailureKind(error, writing),
        error instanceof Error ? error.message : String(error),
        { cause: error }
      )
    }
    assertScope()
    if (!isContract(contract, result))
      throw new ExtensionsRequestError('unavailable', `Unexpected ${method} response`)
    return result
  }
  return {
    async inventory(options = {}) {
      return (await request(
        'extensions/inventory',
        options.includeBinaries === true ? { includeBinaries: true } : {},
        'ExtensionsInventoryResult'
      )) as ExtensionsInventoryResult
    },
    async updateSkillPreference(expectedRevision, preference) {
      return (await request(
        'extensions/skillPreference/update',
        { expectedRevision, preference: normalizePreference(preference) },
        'ExtensionSkillPreferenceResult',
        true
      )) as ExtensionSkillPreferenceResult
    },
    async previewConflicts(params) {
      return (await request(
        'extensions/conflicts/preview',
        params as Record<string, unknown>,
        'ExtensionConflictsPreviewResult'
      )) as ExtensionConflictsPreviewResult
    },
    async setPluginSkillsEnabled(pluginId, enabled, expectedRevision) {
      const result = (await request(
        'plugin/skills/setEnabled',
        { pluginId, enabled, expectedRevision },
        'ExtensionPluginSkillsResult',
        true
      )) as ExtensionPluginSkillsResult
      if (result.pluginId !== pluginId || result.skillsEnabled !== enabled)
        throw new ExtensionsRequestError('unavailable', 'Mismatched plugin skill receipt')
      return result
    },
  }
}

export interface PluginSkillSwitch {
  enabled: boolean
  revision: string
}

/**
 * The per-plugin skill switch of an installed plugin, or null when the target
 * does not support it or the plugin has no switchable skills.
 */
export function pluginSkillSwitch(
  result: ExtensionsInventoryResult | null | undefined,
  pluginId: string | null | undefined
): PluginSkillSwitch | null {
  if (!result?.pluginSkillPolicy || !pluginId) return null
  const plugin = result.items.find(
    item => item.kind === 'plugin' && item.ownerPluginId === pluginId
  )
  if (!plugin?.skillPolicyRevision || typeof plugin.skillsEnabled !== 'boolean') return null
  return { enabled: plugin.skillsEnabled, revision: plugin.skillPolicyRevision }
}

export interface NormalizedPreference {
  preferPluginSkills: Record<string, string>
  preferPlugins: string[]
}

export function normalizePreference(preference?: ExtensionSkillPreference): NormalizedPreference {
  return {
    preferPluginSkills: { ...(preference?.preferPluginSkills ?? {}) },
    preferPlugins: Array.from(new Set(preference?.preferPlugins ?? [])),
  }
}

/** Select one plugin's copy of a skill name over built-in or other plugin copies. */
export function preferPluginCopy(
  preference: ExtensionSkillPreference | undefined,
  name: string,
  pluginId: string
): NormalizedPreference {
  const next = normalizePreference(preference)
  next.preferPluginSkills[name] = pluginId
  return next
}

/**
 * Return to the default (built-in wins) for one name. A per-plugin preference
 * cannot be narrowed to a single name, so the caller must offer the per-plugin
 * control instead when this returns null.
 */
export function restoreDefaultCopy(
  preference: ExtensionSkillPreference | undefined,
  name: string,
  pluginId: string
): NormalizedPreference | null {
  const next = normalizePreference(preference)
  if (next.preferPluginSkills[name] === pluginId) {
    delete next.preferPluginSkills[name]
    return next
  }
  return null
}

export function setPluginPreferred(
  preference: ExtensionSkillPreference | undefined,
  pluginId: string,
  preferred: boolean
): NormalizedPreference {
  const next = normalizePreference(preference)
  next.preferPlugins = preferred
    ? Array.from(new Set([...next.preferPlugins, pluginId]))
    : next.preferPlugins.filter(id => id !== pluginId)
  return next
}

/** How the current preference selects a plugin copy of `name`, if at all. */
export function pluginPreferenceSource(
  preference: ExtensionSkillPreference | undefined,
  name: string,
  pluginId: string
): 'name' | 'plugin' | null {
  const mapped = preference?.preferPluginSkills?.[name]
  if (mapped === pluginId) return 'name'
  if (mapped === undefined && preference?.preferPlugins?.includes(pluginId)) return 'plugin'
  return null
}

/** Preference only reorders plugin copies against built-in, bundled and other plugin copies. */
export function preferenceCanSelect(layer: ExtensionLayer | undefined): boolean {
  return layer === 'builtin' || layer === 'bundled' || layer === 'plugin'
}

/** Merge binary rows from an explicit check into a later inventory taken without probes. */
export function mergeBinaryResult(
  current: ExtensionsInventoryResult,
  binaries: ExtensionsInventoryResult | null
): ExtensionsInventoryResult {
  if (current.binariesIncluded || !binaries?.binariesIncluded) return current
  return {
    ...current,
    items: [...current.items, ...binaries.items.filter(item => item.kind === 'binary')],
    conflicts: [
      ...current.conflicts,
      ...binaries.conflicts.filter(conflict => conflict.kind === 'binary'),
    ],
    binariesIncluded: true,
  }
}

export function pluginNames(items: ExtensionInventoryItem[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const item of items)
    if (item.kind === 'plugin' && item.ownerPluginId) names.set(item.ownerPluginId, item.name)
  return names
}

export interface PreviewSummary {
  skills: number
  shadowed: number
  shadows: number
  sameUpstream: number
  /** Distinct families or names of the copies that stay effective. */
  shadowedBy: string[]
  mcpCoexisting: number
  conflicts: ExtensionConflict[]
}

export function summarizePreview(result: ExtensionConflictsPreviewResult): PreviewSummary {
  const skills = result.entries.filter(entry => entry.kind === 'skill')
  const shadowed = skills.filter(entry => entry.outcome === 'shadowed_by_existing')
  const families = new Set(
    shadowed.map(entry => {
      const prefix = entry.name.split('-')[0]
      return shadowed.filter(other => other.name.startsWith(`${prefix}-`)).length > 1
        ? `${prefix}-*`
        : entry.name
    })
  )
  return {
    skills: skills.length,
    shadowed: shadowed.length,
    shadows: skills.filter(entry => entry.outcome === 'shadows_existing').length,
    sameUpstream: shadowed.filter(entry => entry.sameUpstream).length,
    shadowedBy: Array.from(families),
    mcpCoexisting: result.entries.filter(
      entry => entry.kind === 'mcp_server' && entry.outcome === 'coexists'
    ).length,
    conflicts: result.conflicts,
  }
}

/**
 * Declared names of a marketplace plugin that is not installed yet. Only
 * explicit manifest declarations are used; nothing is inferred from content.
 */
export function declaredPluginNames(manifest: Record<string, unknown> | undefined): {
  skillNames: string[]
  mcpServerNames: string[]
} {
  const skillNames = new Set<string>()
  const skills = manifest?.skills
  for (const value of Array.isArray(skills) ? skills : []) {
    if (typeof value !== 'string') continue
    const name = value
      .replace(/\\/g, '/')
      .replace(/\/SKILL\.md$/i, '')
      .replace(/\/+$/, '')
      .split('/')
      .pop()
    if (name && name !== '.' && name !== '..' && name !== 'skills') skillNames.add(name)
  }
  const servers = manifest?.mcpServers
  const mcpServerNames =
    servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : []
  return {
    skillNames: Array.from(skillNames).slice(0, 512),
    mcpServerNames: mcpServerNames.slice(0, 512),
  }
}
