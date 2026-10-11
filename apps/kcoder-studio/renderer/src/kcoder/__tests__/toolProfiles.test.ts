import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn(async () => ({})) }))
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { readToolProfile, saveToolProfile } from '../toolProfiles'
const request = vi.mocked(requestLocalExecutor)
beforeEach(() => request.mockClear())
test('tool profile reads and leaf-only saves are scoped to the chosen target', async () => {
  await readToolProfile('remote')
  expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    method: 'settings/tools/read',
    params: {},
  })
  await saveToolProfile('remote', 'nano')
  expect(request).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    method: 'settings/tools/save',
    params: { profile: 'nano' },
  })
})
