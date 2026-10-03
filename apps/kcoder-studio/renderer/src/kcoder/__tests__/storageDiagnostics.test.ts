import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: vi.fn(async () => ({})),
}))

import { requestLocalExecutor } from '@/tauri/localExecutor'
import { cleanStorage, disableDebugLog, readStorageReport } from '@/kcoder/storageDiagnostics'

const request = vi.mocked(requestLocalExecutor)

describe('storage diagnostics service', () => {
  beforeEach(() => request.mockClear())

  it('reads the storage report through the diagnostics envelope', async () => {
    await readStorageReport('server-1')
    expect(request).toHaveBeenLastCalledWith('runtime.diagnostics.request', {
      serverId: 'server-1',
      method: 'diagnostics/storage/read',
      params: {},
    })
  })

  it('always confirms a cleanup and addresses the disable call', async () => {
    await cleanStorage('server-1', 'turn-snapshots')
    expect(request).toHaveBeenLastCalledWith('runtime.diagnostics.request', {
      serverId: 'server-1',
      method: 'diagnostics/storage/clean',
      params: { target: 'turn-snapshots', confirm: true },
    })

    await disableDebugLog('server-1')
    expect(request).toHaveBeenLastCalledWith('runtime.diagnostics.request', {
      serverId: 'server-1',
      method: 'diagnostics/debug-log/disable',
      params: {},
    })
  })
})
