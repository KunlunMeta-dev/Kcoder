import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { readProviderSettings, saveProviderSettings } from './providerSettings'
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

test('older targets receive no task scope when the caller has a selected conversation', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ profiles: [], restartRequired: false })
  await readProviderSettings('remote', 'selected-task')
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.providers.request', {
    serverId: 'remote',
    method: 'runtime.providers.list',
    params: {},
  })
})

test('capable targets read the selected conversation after negotiating scope support', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({
    profiles: [],
    restartRequired: false,
    supportsRuntimeScope: true,
  })
  await readProviderSettings('remote', 'selected-task')
  expect(requestLocalExecutor).toHaveBeenCalledTimes(2)
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.providers.request', {
    serverId: 'remote',
    taskId: 'selected-task',
    method: 'runtime.providers.list',
    params: {},
  })
})

test('conversation routing stays in the Gateway envelope rather than provider persisted fields', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ profiles: [], restartRequired: false })
  await saveProviderSettings('remote', {
    id: 'provider',
    model: 'model',
    apiFormat: 'openai_chat_completions',
    endpoint: 'http://127.0.0.1:1',
    contextWindowTokens: 100000,
    maxOutputTokens: 65536,
    apiKey: '',
    makeDefault: false,
    runtimeTaskId: 'selected-task',
    validateConnection: false,
  })
  const input = vi.mocked(requestLocalExecutor).mock.calls[0][1] as {
    taskId: string
    params: Record<string, unknown>
  }
  expect(input.taskId).toBe('selected-task')
  expect(input.params).not.toHaveProperty('runtimeTaskId')
  expect(input.params).not.toHaveProperty('taskId')
  expect(input.params).not.toHaveProperty('apiKey')
  expect(input.params.validateConnection).toBe(false)
})
