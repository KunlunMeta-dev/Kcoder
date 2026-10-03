import { requestLocalExecutor } from '@/tauri/localExecutor'

/** Effective `turn_file_changes` snapshot policy. */
export interface TurnFileChangesPolicy {
  enabled: boolean
  retentionDays: number
  maxTotalBytes: number
  maxFileBytes: number
  ignoreGlobs: string[]
}

export function readTurnFileChangesPolicy(serverId: string) {
  return requestLocalExecutor<TurnFileChangesPolicy>('runtime.settings.request', {
    serverId,
    method: 'settings/turn-file-changes/read',
    params: {},
  })
}

export function saveTurnFileChangesPolicy(serverId: string, policy: TurnFileChangesPolicy) {
  return requestLocalExecutor<TurnFileChangesPolicy>('runtime.settings.request', {
    serverId,
    method: 'settings/turn-file-changes/save',
    params: policy,
  })
}
