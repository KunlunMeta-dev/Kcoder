export type PluginActivationPhase =
  | 'installed'
  | 'disabled'
  | 'credentials_required'
  | 'authorization_required'
  | 'loading'
  | 'mounted'
  | 'usable'
  | 'failed'
  | 'unknown'

export interface PluginActivationComponent {
  kind: 'mcp' | 'hook' | 'skill'
  name: string
  phase: PluginActivationPhase
  toolCount?: number
  errorCode?: string
  authorization?: string
  missingNames?: string[]
}

export interface PluginActivationSnapshot {
  threadId?: string
  generation: number
  operationId?: string
  credentialScope?: string
  phase: PluginActivationPhase
  components: PluginActivationComponent[]
  effectiveFrom?: 'next_turn'
}

export interface PluginLifecycleApi {
  revalidateAvailablePlugin?(
    pluginId: string | number,
    options?: { revalidationAttemptId: string }
  ): Promise<void>
  listActivationConversations?(): Promise<Array<{ taskId: string; title: string }>>
  readPluginActivation?(
    pluginId: string | number,
    options?: { taskId?: string }
  ): Promise<PluginActivationSnapshot>
  configurePluginCredentials?(
    pluginId: string | number,
    values: Record<string, string>,
    options?: {
      expectedOperationId?: string
      expectedGeneration?: number
      expectedCredentialScope?: string
    }
  ): Promise<{ missingNames: string[]; effectiveFrom: 'next_turn'; generation: number }>
}

const phases = new Set<PluginActivationPhase>([
  'installed',
  'disabled',
  'credentials_required',
  'authorization_required',
  'loading',
  'mounted',
  'usable',
  'failed',
  'unknown',
])

/** A catalog/package declaration is never evidence of an activated component. */
export function normalizePluginActivation(value: unknown): PluginActivationSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Partial<PluginActivationSnapshot>
  if (!Number.isSafeInteger(snapshot.generation) || Number(snapshot.generation) < 0) return null
  if (!phases.has(snapshot.phase as PluginActivationPhase) || !Array.isArray(snapshot.components))
    return null
  const components = snapshot.components.filter(
    (component): component is PluginActivationComponent =>
      Boolean(component) &&
      ['mcp', 'hook', 'skill'].includes(component.kind) &&
      typeof component.name === 'string' &&
      phases.has(component.phase)
  )
  const hasThread = typeof snapshot.threadId === 'string' && Boolean(snapshot.threadId.trim())
  const normalized = components.map(component => {
    const reason = component.kind === 'mcp' ? mcpActivationReason(component.errorCode) : null
    const reportedPhase = reason
      ? reason === 'noTools'
        ? 'mounted'
        : reason === 'authorizationRequired'
          ? 'authorization_required'
          : 'failed'
      : component.phase
    const phase =
      (reportedPhase === 'usable' || reportedPhase === 'mounted') && !hasThread
        ? 'unknown'
        : component.kind === 'mcp' &&
            reportedPhase === 'usable' &&
            (!Number.isSafeInteger(component.toolCount) || Number(component.toolCount) <= 0)
          ? 'mounted'
          : reportedPhase
    return {
      kind: component.kind,
      name: component.name.slice(0, 200),
      phase,
      ...(Number.isSafeInteger(component.toolCount) && Number(component.toolCount) >= 0
        ? { toolCount: component.toolCount }
        : {}),
      ...(typeof component.errorCode === 'string' && /^[a-z_\d.-]{1,80}$/i.test(component.errorCode)
        ? { errorCode: component.errorCode }
        : {}),
      ...(typeof component.authorization === 'string' &&
      [
        'notApplicable',
        'configuredHeader',
        'notAuthorized',
        'authorized',
        'expired',
        'reauthorizationRequired',
        'unavailable',
      ].includes(component.authorization)
        ? { authorization: component.authorization }
        : {}),
      ...(Array.isArray(component.missingNames)
        ? { missingNames: credentialNames(component.missingNames) }
        : {}),
    }
  })
  const phase =
    (snapshot.phase === 'usable' || snapshot.phase === 'mounted') && !hasThread
      ? 'unknown'
      : snapshot.phase === 'usable' &&
          (normalized.length === 0 || normalized.some(item => item.phase !== 'usable'))
        ? (normalized.find(item => item.phase !== 'usable')?.phase ?? 'unknown')
        : (snapshot.phase as PluginActivationPhase)
  return {
    generation: Number(snapshot.generation),
    phase,
    ...(typeof snapshot.threadId === 'string' ? { threadId: snapshot.threadId } : {}),
    ...(typeof snapshot.operationId === 'string' ? { operationId: snapshot.operationId } : {}),
    ...(typeof snapshot.credentialScope === 'string' &&
    /^[a-f0-9]{64}$/.test(snapshot.credentialScope)
      ? { credentialScope: snapshot.credentialScope }
      : {}),
    ...(snapshot.effectiveFrom === 'next_turn' ? { effectiveFrom: 'next_turn' } : {}),
    components: normalized,
  }
}

/** Only bounded credential identifiers can become form controls. */
export function credentialNames(names: unknown[]): string[] {
  return [
    ...new Set(
      names.filter(
        (name): name is string =>
          typeof name === 'string' && /^[A-Za-z_][A-Za-z_\d.:-]{0,127}$/.test(name)
      )
    ),
  ].slice(0, 32)
}

export function canRevalidatePlugin(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const value = manifest as {
    installationAvailability?: { category?: unknown; retryable?: unknown }
    compatibility?: { issues?: unknown }
  }
  if (value.installationAvailability?.retryable !== true) return false
  if (!Array.isArray(value.compatibility?.issues)) return false
  const issues = value.compatibility.issues.filter(
    issue => issue && typeof issue.code === 'string' && issue.code.startsWith('installation_')
  )
  return (
    issues.length > 0 && issues.every(issue => issue.code === 'installation_download_unverified')
  )
}

/** Recovery observations belong to a catalog revision and exact source. */
export function pluginCatalogIdentity(item: {
  id: string | number
  version?: string | null
  manifest?: Record<string, unknown>
}): string {
  const raw = item.manifest?.source
  const source: Record<string, unknown> = {}
  if (raw && typeof raw === 'object')
    for (const key of [
      'type',
      'url',
      'path',
      'ref_name',
      'sha',
      'id',
      'version',
      'package',
      'integrity',
      'bundle',
      'digest',
    ]) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === 'string') source[key] = value
    }
  return JSON.stringify([item.id, item.version ?? null, source])
}

/** Bounded known codes select actionable localized copy; older/unknown peers stay generic. */
export function mcpActivationReason(code?: string): string | null {
  if (!code) return null
  return (
    (
      {
        mcp_connection_failed: 'connectionFailed',
        mcp_protocol_failed: 'protocolFailed',
        mcp_authorization_required: 'authorizationRequired',
        mcp_no_tools: 'noTools',
        mcp_timeout: 'timedOut',
        mcp_unavailable: 'unavailable',
      } as Record<string, string>
    )[code] ?? 'unavailable'
  )
}
