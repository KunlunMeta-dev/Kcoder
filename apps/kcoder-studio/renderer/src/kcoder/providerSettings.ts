import type { ModelReasoningPolicy } from '../../../shared/modelConfiguration'
import { requestLocalExecutor } from '@/tauri/localExecutor'

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

export type ProviderDraft = Omit<
  ProviderProfile,
  | 'apiKeyConfigured'
  | 'isDefault'
  | 'canDelete'
  | 'isProviderDefault'
  | 'fileSources'
  | 'availableInCurrentConfig'
> & {
  expectedRevision?: string
  apiKey: string
  makeDefault: boolean
  originalModel?: string
}

export function readProviderSettings(serverId: string) {
  return requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
    serverId,
    method: 'runtime.providers.list',
    params: {},
  })
}

export function saveProviderSettings(serverId: string, draft: ProviderDraft) {
  const { apiKey, extraBody, ...fields } = draft
  return requestLocalExecutor<ProviderSettings>('runtime.providers.request', {
    serverId,
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
