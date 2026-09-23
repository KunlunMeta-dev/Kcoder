import type { ProviderProfile } from '@/kcoder/providerSettings'

export const fields = {
  endpoint: 'endpoint',
  api_format: 'apiFormat',
  authentication: 'authentication',
  chat_protocol: 'chatProtocol',
  context_window_tokens: 'contextWindowTokens',
  output_headroom_tokens: 'sourceOutputHeadroom',
  max_output_tokens: 'maxOutputTokens',
  capabilities: 'capabilities',
  reasoning_effort: 'reasoningEffort',
  reasoning_policy: 'reasoningPolicy',
  extra_body: 'extraBody',
} as const
export const layers = new Set(['default', 'user', 'executable', 'project', 'local', 'overlay'])
const overridingLayers = new Set(['executable', 'project', 'local', 'overlay'])

export function hasFileOverrides(profile?: ProviderProfile): boolean {
  return Object.keys(fields).some(
    field =>
      Array.isArray(profile?.fileSources?.[field]) &&
      profile.fileSources[field].some(layer => overridingLayers.has(layer))
  )
}
