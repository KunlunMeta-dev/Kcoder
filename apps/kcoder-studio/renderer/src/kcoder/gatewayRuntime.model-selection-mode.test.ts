import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { MODEL_SELECTION_MODE_CAPABILITY } from './modelSelectionMode'

describe.each([Runtime, InstalledRuntime])('model selection intent adapter', RuntimeClass => {
  test('rejects unsupported mode before interrupting, writing metadata or sending a turn', async () => {
    const client = new FakeGatewayClient('thread-mode-legacy')
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'mode-task', executionRequest: { prompt: 'original' } }) as { taskId: string }
      const original = client.supportsExperimental.bind(client)
      client.supportsExperimental = name => name !== MODEL_SELECTION_MODE_CAPABILITY && original(name)
      const before = client.requests.length
      await expect(runtime.request('runtime.tasks.send', { taskId: created.taskId, deviceId: 'local', message: 'next',
        modelSelectionMode: 'follow_target_default', executionRequest: {} })).rejects.toThrow('does not support')
      expect(client.requests.slice(before).filter(request => ['turn/start', 'turn/interrupt', 'thread/metadata/update'].includes(request.method))).toEqual([])
    } finally { await runtime.dispose() }
  })

  test('forwards supported follow mode without inheriting a cached model', async () => {
    const client = new FakeGatewayClient('thread-mode-supported')
    const original = client.supportsExperimental.bind(client)
    client.supportsExperimental = name => name === MODEL_SELECTION_MODE_CAPABILITY || original(name)
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'mode-task', executionRequest: { prompt: 'original' } }) as { taskId: string }
      const before = client.requests.length
      await runtime.request('runtime.tasks.send', { taskId: created.taskId, deviceId: 'local', message: 'next',
        modelSelectionMode: 'follow_target_default', executionRequest: {} })
      const turn = client.requests.slice(before).find(request => request.method === 'turn/start')
      expect(turn?.params.modelSelectionMode).toBe('follow_target_default')
      expect(turn?.params.model).toBeUndefined()
      const nextOffset = client.requests.length
      await runtime.request('runtime.tasks.send', { taskId: created.taskId, deviceId: 'local', message: 'next again', executionRequest: {} })
      const nextTurn = client.requests.slice(nextOffset).find(request => request.method === 'turn/start')
      expect(nextTurn?.params.modelSelectionMode).toBe('follow_target_default')
      expect(nextTurn?.params.model).toBeUndefined()
    } finally { await runtime.dispose() }
  })
  test('a send waiting for reconnect uses restored follow intent instead of stale task metadata', async () => {
    const first = new FakeGatewayClient('thread-mode-resume')
    const second = new FakeGatewayClient('thread-mode-resume')
    let release!: () => void
    second.resumeGate = new Promise<void>(resolve => { release = resolve })
    const originalRequest = second.request.bind(second)
    second.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const result = await originalRequest<T>(method, params)
      if (method === 'thread/resume') return { thread: { id: params.threadId,
        modelSelectionMode: 'follow_target_default', selectedModel: 'restored::model' } } as T
      return result
    }
    const clients = [first, second]
    let issued = 0
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()],
      createClient: () => clients[issued++]! })
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'mode-resume-task', executionRequest: { prompt: 'original' } }) as { taskId: string }
      first.close()
      await vi.waitFor(() => expect(second.requests.some(request => request.method === 'thread/resume')).toBe(true))
      const pending = runtime.request('runtime.tasks.send', { taskId: created.taskId, deviceId: 'local', message: 'after reconnect', executionRequest: {} })
      expect(second.requests.some(request => request.method === 'turn/start')).toBe(false)
      release()
      await expect(pending).resolves.toMatchObject({ accepted: true })
      const turn = second.requests.find(request => request.method === 'turn/start')
      expect(turn?.params.modelSelectionMode).toBe('follow_target_default')
      expect(turn?.params.model).toBeUndefined()
      expect(issued).toBe(2)
    } finally { release(); await runtime.dispose() }
  })

  test('new conversations preserve follow intent for the first and next request', async () => {
    const client = new FakeGatewayClient('thread-new-follow')
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'new-follow',
        modelSelectionMode: 'follow_target_default', modelSelection: { modelName: '', modelType: null, options: {} },
        executionRequest: { prompt: 'first' } }) as { taskId: string }
      await runtime.request('runtime.tasks.send', { taskId: created.taskId, message: 'second' })
      const turns = client.requests.filter(request => request.method === 'turn/start')
      expect(turns).toHaveLength(2)
      for (const turn of turns) {
        expect(turn.params.modelSelectionMode).toBe('follow_target_default')
        expect(turn.params.model).toBeUndefined()
      }
    } finally { await runtime.dispose() }
  })

  test('unsupported following is rejected before creating a thread', async () => {
    const client = new FakeGatewayClient('thread-unsupported-follow')
    const original = client.supportsExperimental.bind(client)
    client.supportsExperimental = name => name !== MODEL_SELECTION_MODE_CAPABILITY && original(name)
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      await expect(runtime.request('runtime.tasks.create', { taskId: 'unsupported-follow',
        modelSelectionMode: 'follow_target_default', executionRequest: { prompt: 'first' } })).rejects.toThrow('does not support')
      expect(client.requests.some(request => request.method === 'thread/start')).toBe(false)
      expect(client.requests.some(request => request.method === 'turn/start')).toBe(false)
    } finally { await runtime.dispose() }
  })

})
