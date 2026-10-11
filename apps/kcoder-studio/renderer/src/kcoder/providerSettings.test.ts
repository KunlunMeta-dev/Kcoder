import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { deleteProviderSettings, saveProviderSettings } from './providerSettings'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

test('model deletion sends the model identity and sibling replacement, not an API replacement', async () => {
  await deleteProviderSettings('remote', 'shared', {
    model: 'first',
    replacementModel: 'second',
    removeCredentials: false,
  })
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.providers.request', {
    serverId: 'remote',
    method: 'runtime.providers.delete',
    params: {
      id: 'shared',
      model: 'first',
      replacementModel: 'second',
      removeCredentials: false,
      confirm: true,
    },
  })
})

test('omits blank credentials and routes provider writes only to the selected target', async () => {
  await saveProviderSettings('remote', {
    id: 'custom',
    apiFormat: 'openai_responses',
    endpoint: 'https://example.invalid/v1',
    model: 'user-model',
    contextWindowTokens: 32000,
    maxOutputTokens: 4096,
    apiKey: ' ',
    makeDefault: true,
  })
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.providers.request', {
    serverId: 'remote',
    method: 'runtime.providers.upsert',
    params: expect.not.objectContaining({ apiKey: expect.anything() }),
  })
})

test('confirmed deletion preserves credentials by default and routes only to the chosen target', async () => {
  const result = { profiles: [], restartRequired: true }
  vi.mocked(requestLocalExecutor).mockResolvedValue(result)
  await expect(
    deleteProviderSettings('ssh-target', 'custom', { removeCredentials: false })
  ).resolves.toBe(result)
  expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('runtime.providers.request', {
    serverId: 'ssh-target',
    method: 'runtime.providers.delete',
    params: { id: 'custom', confirm: true, removeCredentials: false },
  })
})

test('default replacement and credential removal are explicit deletion options, not separate writes', async () => {
  await deleteProviderSettings('local', 'default-api', {
    replacementProvider: 'backup-api',
    removeCredentials: true,
  })
  expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('runtime.providers.request', {
    serverId: 'local',
    method: 'runtime.providers.delete',
    params: {
      id: 'default-api',
      confirm: true,
      replacementProvider: 'backup-api',
      removeCredentials: true,
    },
  })
})

test('deletion failure is propagated without restart, retry or a second target mutation', async () => {
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(new Error('Deletion refused'))
  await expect(
    deleteProviderSettings('remote', 'custom', { removeCredentials: false })
  ).rejects.toThrow('Deletion refused')
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
})

test('forwards the captured editor revision without changing the selected target', async () => {
  await saveProviderSettings('remote', {
    id: 'custom',
    apiFormat: 'openai_responses',
    endpoint: 'https://example.invalid/v1',
    model: 'model',
    contextWindowTokens: 32000,
    maxOutputTokens: 4096,
    apiKey: '',
    makeDefault: false,
    expectedRevision: 'opaque-v1',
  })
  expect(requestLocalExecutor).toHaveBeenCalledWith(
    'runtime.providers.request',
    expect.objectContaining({
      serverId: 'remote',
      params: expect.objectContaining({ expectedRevision: 'opaque-v1' }),
    })
  )
})
