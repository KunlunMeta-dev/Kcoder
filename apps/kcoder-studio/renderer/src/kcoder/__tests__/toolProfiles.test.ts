import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn(async () => ({})) }))
import { requestLocalExecutor } from '@/host/localExecutor'
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

test('an optional editor hint narrows routing without entering Native settings fields', async () => {
  await readToolProfile('remote', { targetScope: 'original' })
  await saveToolProfile('remote', 'nano', { targetScope: 'original' })
  expect(request.mock.calls).toEqual([
    ['runtime.settings.request', { serverId: 'remote', targetScope: 'original', method: 'settings/tools/read', params: {} }],
    ['runtime.settings.request', { serverId: 'remote', targetScope: 'original', method: 'settings/tools/save', params: { profile: 'nano' } }],
  ])
})
