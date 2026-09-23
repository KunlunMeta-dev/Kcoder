import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

const emitMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: vi.fn(async () => () => undefined),
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(onResolve => {
    resolve = onResolve
  })
  return { promise, resolve }
}

beforeEach(() => emitMock.mockReset().mockResolvedValue(undefined))

describe('KCoder gateway runtime asynchronous teardown', () => {
  test('drains notification work before teardown and ignores later notifications', async () => {
    const gate = deferred()
    emitMock.mockImplementation(() => gate.promise)
    const client = new FakeGatewayClient(null)
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '本机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.status()
    client.emitNotification('turn/started', { threadId: 'thread', turnId: 'turn' })
    await vi.waitFor(() => expect(emitMock).toHaveBeenCalled())
    expect(emitMock).toHaveBeenNthCalledWith(1, 'local-executor:event', {
      event: 'response.created',
      payload: {
        taskId: 'thread',
        subtaskId: 'turn',
        deviceId: 'local',
        data: {},
      },
    })

    let drained = false
    const disposing = runtime.disposeAsync().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    await disposing
    const callsAfterDrain = emitMock.mock.calls.length
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    client.emitNotification('turn/started', { threadId: 'late', turnId: 'late-turn' })
    await Promise.resolve()
    await Promise.resolve()
    window.removeEventListener('unhandledrejection', unhandled)

    expect(emitMock).toHaveBeenCalledTimes(callsAfterDrain)
    expect(unhandled).not.toHaveBeenCalled()
  })

  test('waits for an in-progress reconnect delay before clearing test mocks', async () => {
    const first = new FakeGatewayClient('thread-reconnect-drain')
    const failedResume = new FakeGatewayClient('thread-reconnect-drain')
    failedResume.resumeFailure = new Error('resume failed')
    const clients = [first, failedResume]
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '本机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => clients.shift()!,
    })
    await runtime.request('runtime.tasks.create', {
      taskId: 'reconnect-drain',
      executionRequest: { prompt: 'start' },
    })
    first.close()
    await vi.waitFor(() =>
      expect(failedResume.requests).toContainEqual({
        method: 'thread/resume',
        params: { threadId: 'thread-reconnect-drain' },
      })
    )
    expect(emitMock.mock.calls.map(([, payload]) => payload.event)).toEqual([
      'response.failed',
      'response.block.created',
    ])
    const reconnectSubtaskId = emitMock.mock.calls[1]?.[1].payload.subtaskId
    expect(reconnectSubtaskId).toMatch(/^runtime-reconnecting-thread-reconnect-drain-/)
    expect(emitMock.mock.calls[1]?.[1]).toMatchObject({
      payload: {
        taskId: 'kcoder:local:thread-reconnect-drain',
        subtaskId: reconnectSubtaskId,
        deviceId: 'local',
        data: {
          block: { id: reconnectSubtaskId, toolName: 'runtime_reconnecting', status: 'pending' },
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    let drained = false
    const disposing = runtime.disposeAsync().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await disposing
  })

  test('waits for a client that is still connecting and closes it after disposal', async () => {
    const gate = deferred()
    const client = new FakeGatewayClient(null)
    client.connectGate = gate.promise
    let issued = false
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '本机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => {
        issued = true
        return client
      },
    })
    const statusOutcome = runtime.status().catch(error => error)
    await vi.waitFor(() => expect(issued).toBe(true))
    let drained = false
    const disposing = runtime.disposeAsync().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.resolve()
    await disposing
    expect(await statusOutcome).toBeInstanceOf(Error)
    expect(client.closed).toBe(true)
  })

  test('waits for an opening browser before disposal completes', async () => {
    const gate = deferred()
    const client = new FakeGatewayClient('browser-opening-drain')
    client.browserStartGate = gate.promise
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '本机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    const opening = runtime
      .openBrowser({ label: 'opening', url: 'https://example.test/' })
      .catch(error => error)
    await vi.waitFor(() =>
      expect(client.requests.some(request => request.method === 'browser/start')).toBe(true)
    )
    let drained = false
    const disposing = runtime.disposeAsync().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.resolve()
    await disposing
    expect(await opening).toBeInstanceOf(Error)
    expect(client.closed).toBe(true)
  })

  test('waits for the browser close RPC before disposal completes', async () => {
    const gate = deferred()
    const client = new FakeGatewayClient('browser-close-drain')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '本机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    await runtime.openBrowser({ label: 'closing', url: 'https://example.test/' })
    client.browserCloseGate = gate.promise
    let drained = false
    const disposing = runtime.disposeAsync().then(() => {
      drained = true
    })
    await vi.waitFor(() =>
      expect(client.requests.some(request => request.method === 'browser/close')).toBe(true)
    )
    expect(drained).toBe(false)

    gate.resolve()
    await disposing
    expect(client.closed).toBe(true)
  })
})
