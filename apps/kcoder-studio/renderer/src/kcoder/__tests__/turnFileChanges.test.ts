import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn(async () => ({})) }))

import { requestLocalExecutor } from '@/tauri/localExecutor'
import { readTurnFileChangesPolicy, saveTurnFileChangesPolicy } from '@/kcoder/turnFileChanges'

const request = vi.mocked(requestLocalExecutor)

describe('turn file changes policy service', () => {
  beforeEach(() => request.mockClear())

  it('reads the policy through the settings envelope', async () => {
    await readTurnFileChangesPolicy('server-1')
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/turn-file-changes/read',
      params: {},
    })
  })

  it('sends the full policy when saving', async () => {
    const policy = {
      enabled: true,
      retentionDays: 7,
      maxTotalBytes: 1024,
      maxFileBytes: 512,
      ignoreGlobs: ['**/*.gguf'],
    }
    await saveTurnFileChangesPolicy('server-1', policy)
    expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
      serverId: 'server-1',
      method: 'settings/turn-file-changes/save',
      params: policy,
    })
  })
})
