import { requestLocalExecutor } from '@/host/localExecutor'

export const TOOL_PROFILES = ['full', 'core', 'nano', 'none'] as const
export type ToolProfile = (typeof TOOL_PROFILES)[number]
export interface ToolProfileSettings {
  profile: ToolProfile
  effectiveProfile: ToolProfile
  cliOverride: ToolProfile | null
}

export function readToolProfile(serverId: string, expected?: { targetScope: string }) {
  return requestLocalExecutor<ToolProfileSettings>('runtime.settings.request', {
    serverId,
    ...(expected ? { targetScope: expected.targetScope } : {}),
    method: 'settings/tools/read',
    params: {},
  })
}

export function saveToolProfile(serverId: string, profile: ToolProfile, expected?: { targetScope: string }) {
  return requestLocalExecutor<ToolProfileSettings>('runtime.settings.request', {
    serverId,
    ...(expected ? { targetScope: expected.targetScope } : {}),
    method: 'settings/tools/save',
    params: { profile },
  })
}
