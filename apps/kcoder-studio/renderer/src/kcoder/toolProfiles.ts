import { requestLocalExecutor } from '@/tauri/localExecutor'

export const TOOL_PROFILES = ['full', 'core', 'nano', 'none'] as const
export type ToolProfile = (typeof TOOL_PROFILES)[number]
export interface ToolProfileSettings {
  profile: ToolProfile
  effectiveProfile: ToolProfile
  cliOverride: ToolProfile | null
}

export function readToolProfile(serverId: string) {
  return requestLocalExecutor<ToolProfileSettings>('runtime.settings.request', {
    serverId,
    method: 'settings/tools/read',
    params: {},
  })
}

export function saveToolProfile(serverId: string, profile: ToolProfile) {
  return requestLocalExecutor<ToolProfileSettings>('runtime.settings.request', {
    serverId,
    method: 'settings/tools/save',
    params: { profile },
  })
}
