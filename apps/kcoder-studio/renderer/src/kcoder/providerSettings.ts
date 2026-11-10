import type {
  ModelReasoningPolicy,
  ModelConfigurationSummary,
} from '../../../shared/modelConfiguration'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isProviderDiscoveredModels } from '../../../shared/generated/contractGuards.mjs'

export interface ProviderAuthentication {
  mode: 'api_key' | 'none'
}

export interface ProviderModelCapabilities {
  text: boolean
  tools: boolean
  vision: boolean
  reasoning: boolean
  structured_output: boolean
}

export interface ProviderTemplate {
  id: string
  displayName: string
  apiFormat: string
  endpoint: string
  documentationUrl: string
  authentication?: ProviderAuthentication
}

export function readProviderTemplates(serverId: string) {
  return requestLocalExecutor<{
    templates: ProviderTemplate[]
    supportsAuthenticationPolicy?: boolean
  }>('runtime.providers.request', {
    serverId,
    method: 'runtime.providers.templates',
    params: {},
  })
}

export interface ProviderProfile {
  profileConfiguration?: ModelConfigurationSummary
  nextTurnConfiguration?: ModelConfigurationSummary

  fileSources?: Record<string, string[]>
  availableInCurrentConfig?: boolean
  chatProtocol?: 'auto' | 'standard' | 'minimax'
  reasoningEffort?: string | null
  reasoningPolicy?: ModelReasoningPolicy
  extraBody?: Record<string, unknown>
  capabilities?: ProviderModelCapabilities
  id: string
  apiFormat: string
  endpoint: string
  model: string
  contextWindowTokens: number
  maxOutputTokens: number
  apiKeyConfigured: boolean
  authentication?: ProviderAuthentication
  isDefault: boolean
  isProviderDefault?: boolean
  canDelete?: boolean
}

export interface ProviderSettings {
  supportsModelDiscovery?: boolean
  supportsIndependentProbe?: boolean
  supportsRuntimeScope?: boolean
  supportsClearUserOverrides?: boolean
  currentTurnConfiguration?: ModelConfigurationSummary
  clearableUserOverrides?: string[]

  supportsOptimisticConcurrency?: boolean
  revision?: string
  savedRevision?: string
  supportsChatProtocol?: boolean
  supportsModelReasoning?: boolean
  supportsModelReasoningPolicy?: boolean
  supportsExtraBody?: boolean
  supportsModelExtraBody?: boolean
  supportsTurnModelReload?: boolean
  supportsNewSessionReload?: boolean
  supportsMultipleModels?: boolean
  supportsModelCapabilities?: boolean
  profiles: ProviderProfile[]
  restartRequired: boolean
  warning?: string | null
}

export async function discoverProviderSettingsModels(
  serverId: string,
  draft: Pick<ProviderDraft, 'id' | 'endpoint' | 'apiFormat' | 'apiKey' | 'authentication'>,
  options?: { signal?: AbortSignal }
) {
  const result = await requestLocalExecutor<unknown>(
    'runtime.providers.request',
    {
      serverId,
      method: 'runtime.providers.discoverModels',
      params: {
        ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
        endpoint: draft.endpoint.trim(),
        apiFormat: draft.apiFormat,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
        authentication: draft.authentication ?? { mode: 'api_key' },
      },
    },
    options
  )
  if (!isProviderDiscoveredModels(result))
    throw new Error('[provider_discovery_response] Invalid model list')
  return result
}

export type ProviderDraft = Omit<
  ProviderProfile,
  | 'profileConfiguration'
  | 'nextTurnConfiguration'
  | 'apiKeyConfigured'
  | 'isDefault'
  | 'canDelete'
  | 'isProviderDefault'
  | 'fileSources'
  | 'availableInCurrentConfig'
> & {
  runtimeTaskId?: string
  validateConnection?: boolean
  expectedRevision?: string
  apiKey: string
  makeDefault: boolean
  originalModel?: string
}

export async function readProviderSettings(serverId: string, taskId?: string) {
  const read = (scopedTaskId?: string) =>
    requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
      serverId,
      ...(scopedTaskId ? { taskId: scopedTaskId } : {}),
      method: 'runtime.providers.list',
      params: {},
    })
  const unscoped = await read()
  return taskId && unscoped.supportsRuntimeScope ? read(taskId) : unscoped
}

export function saveProviderSettings(serverId: string, draft: ProviderDraft) {
  const { apiKey, extraBody, runtimeTaskId, ...fields } = draft
  return requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
    serverId,
    ...(runtimeTaskId ? { taskId: runtimeTaskId } : {}),
    method: 'runtime.providers.upsert',
    params: {
      ...fields,
      ...(extraBody !== undefined ? { modelExtraBody: extraBody } : {}),
      ...(apiKey.trim() ? { apiKey } : {}),
    },
  })
}

export function applyProviderSettings(serverId: string) {
  return requestLocalExecutor<{ restarted: boolean; requiresConfirmation: boolean }>(
    'runtime.providers.restart',
    { serverId }
  )
}

export function deleteProviderSettings(
  serverId: string,
  id: string,
  options: {
    replacementProvider?: string
    model?: string
    replacementModel?: string
    removeCredentials: boolean
  }
) {
  return requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
    serverId,
    method: 'runtime.providers.delete',
    params: { id, confirm: true, ...options },
  })
}

export interface ProviderProbeResult {
  provider: string
  model: string
  revision: string
  configurationRevision: string
  success: boolean
  errorType?: string
}

export function probeProviderSettings(
  serverId: string,
  profile: ProviderProfile,
  expectedRevision: string,
  taskId?: string
) {
  return requestLocalExecutor<ProviderProbeResult>('runtime.providers.request', {
    serverId,
    ...(taskId ? { taskId } : {}),
    method: 'runtime.providers.probe',
    params: {
      id: profile.id,
      model: profile.model,
      expectedRevision,
      ...(profile.nextTurnConfiguration
        ? { expectedConfigurationRevision: profile.nextTurnConfiguration.revision }
        : {}),
    },
  })
}

export function clearProviderUserOverride(
  serverId: string,
  field: string,
  expectedRevision: string,
  taskId?: string
) {
  return requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
    serverId,
    ...(taskId ? { taskId } : {}),
    method: 'runtime.providers.clearUserOverride',
    params: { field, expectedRevision },
  })
}
