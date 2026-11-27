import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

const threadId = 'transcript-notification-barrier'
const prefixTurnId = 'prefix-turn'
const laterTurnId = 'later-turn'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve
  })
  return { promise, resolve }
}

async function liveFixture(client = new FakeGatewayClient(threadId)) {
  client.threadResumeSupported = true
  client.indexedPagesSupported = true
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'transcript-barrier-task',
    workspacePath: '/workspace',
    executionRequest: { prompt: 'original input' },
  })) as { taskId: string }
  const address = {
    taskId: created.taskId,
    deviceId: 'local',
    threadId,
    workspacePath: '/workspace',
    attachToLiveTurn: true,
  }
  return { runtime, client, address }
}

function holdTurnStartedProjection(
  runtime: ReturnType<typeof createTestGatewayRuntime>,
  client: FakeGatewayClient
) {
  const prefixEntered = deferred()
  const releasePrefix = deferred()
  const laterEntered = deferred()
  const releaseLater = deferred()
  const originalForward = runtime.forwardNotification.bind(runtime)
  runtime.forwardNotification = (async (
    ...args: Parameters<typeof runtime.forwardNotification>
  ) => {
    const [method, params] = args
    if (method === 'turn/started' && params.turnId === prefixTurnId) {
      prefixEntered.resolve()
      await releasePrefix.promise
    }
    if (method === 'turn/started' && params.turnId === laterTurnId) {
      laterEntered.resolve()
      await releaseLater.promise
    }
    return originalForward(...args)
  }) as typeof runtime.forwardNotification

  client.emitNotification('turn/started', {
    threadId,
    turnId: prefixTurnId,
    turn: { id: prefixTurnId, status: 'inProgress' },
  })

  return { prefixEntered, releasePrefix, laterEntered, releaseLater }
}

function observeTranscriptQueueRead(
  runtime: ReturnType<typeof createTestGatewayRuntime>,
  client: FakeGatewayClient
) {
  const queue = runtime.notificationQueueByClient
  const originalGet = queue.get.bind(queue)
  const captured = deferred<{ prefix: Promise<void> }>()
  let observed = false
  Object.defineProperty(queue, 'get', {
    configurable: true,
    value: (candidate: Parameters<typeof queue.get>[0]) => {
      const current = originalGet(candidate)
      if (
        !observed &&
        candidate === client &&
        client.requests.some(request => request.method === 'thread/read/indexed')
      ) {
        observed = true
        captured.resolve({ prefix: current ?? Promise.resolve() })
      }
      return current
    },
  })
  return {
    captured: captured.promise,
    getCurrent: () => originalGet(client),
    restore: () => Reflect.deleteProperty(queue, 'get'),
  }
}

beforeEach(() => localStorage.clear())

afterEach(() => vi.restoreAllMocks())

test('an indexed snapshot drains only its earlier notification prefix', async () => {
  const { runtime, client, address } = await liveFixture()
  const projection = holdTurnStartedProjection(runtime, client)
  let queueObserver: ReturnType<typeof observeTranscriptQueueRead> | undefined
  let read: Promise<{ taskId: string; messages: unknown[] }> | undefined
  try {
    await projection.prefixEntered.promise
    queueObserver = observeTranscriptQueueRead(runtime, client)
    read = runtime.request('runtime.tasks.transcript', address) as Promise<{
      taskId: string
      messages: unknown[]
    }>
    let readSettled = false
    void read.then(
      () => {
        readSettled = true
      },
      () => {
        readSettled = true
      }
    )

    const { prefix } = await queueObserver.captured
    expect(client.requests.some(request => request.method === 'thread/read/indexed')).toBe(true)
    expect(readSettled).toBe(false)

    client.emitNotification('turn/started', {
      threadId,
      turnId: laterTurnId,
      turn: { id: laterTurnId, status: 'inProgress' },
    })
    expect(queueObserver.getCurrent()).not.toBe(prefix)

    projection.releasePrefix.resolve()
    await projection.laterEntered.promise
    await expect(read).resolves.toMatchObject({ taskId: address.taskId })
    expect(readSettled).toBe(true)
  } finally {
    projection.releasePrefix.resolve()
    projection.releaseLater.resolve()
    queueObserver?.restore()
    await queueObserver?.getCurrent()?.catch(() => undefined)
    await runtime.disposeAsync()
  }
})

test('a live transcript rejects if its task owner changes while the prefix drains', async () => {
  const { runtime, client, address } = await liveFixture()
  const projection = holdTurnStartedProjection(runtime, client)
  const queueObserver = observeTranscriptQueueRead(runtime, client)
  try {
    await projection.prefixEntered.promise
    const read = runtime.request('runtime.tasks.transcript', address)
    const { prefix } = await queueObserver.captured
    expect(client.requests.some(request => request.method === 'thread/read/indexed')).toBe(true)
    expect(queueObserver.getCurrent()).toBe(prefix)
    const current = runtime.tasks.get(address.taskId)!
    runtime.tasks.set(address.taskId, { ...current, workspacePath: '/replaced-owner' })

    projection.releasePrefix.resolve()
    await expect(read).rejects.toThrow('LIVE_TRANSCRIPT_ORIGINAL_OWNER_UNAVAILABLE')
  } finally {
    projection.releasePrefix.resolve()
    projection.releaseLater.resolve()
    queueObserver.restore()
    await queueObserver.getCurrent()?.catch(() => undefined)
    await runtime.disposeAsync()
  }
})

test('a live transcript rejects after disposal while waiting for its notification prefix', async () => {
  const { runtime, client, address } = await liveFixture()
  const projection = holdTurnStartedProjection(runtime, client)
  const queueObserver = observeTranscriptQueueRead(runtime, client)
  try {
    await projection.prefixEntered.promise
    const read = runtime.request('runtime.tasks.transcript', address)
    await queueObserver.captured
    expect(client.requests.some(request => request.method === 'thread/read/indexed')).toBe(true)

    const disposing = runtime.disposeAsync()
    projection.releasePrefix.resolve()
    await expect(read).rejects.toThrow('LIVE_TRANSCRIPT_ORIGINAL_OWNER_UNAVAILABLE')
    projection.releaseLater.resolve()
    await disposing
  } finally {
    projection.releasePrefix.resolve()
    projection.releaseLater.resolve()
    queueObserver.restore()
    await queueObserver.getCurrent()?.catch(() => undefined)
    await runtime.disposeAsync()
  }
})

test('an ordinary transcript read does not wait for another live client queue', async () => {
  const liveClient = new FakeGatewayClient(threadId)
  const readClient = new FakeGatewayClient(threadId)
  liveClient.threadResumeSupported = readClient.threadResumeSupported = true
  liveClient.indexedPagesSupported = readClient.indexedPagesSupported = true
  const clients = [liveClient, readClient]
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => clients.shift()!,
  })
  let projection: ReturnType<typeof holdTurnStartedProjection> | undefined
  try {
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'ordinary-transcript-task',
      workspacePath: '/workspace',
      executionRequest: { prompt: 'original input' },
    })) as { taskId: string }
    projection = holdTurnStartedProjection(runtime, liveClient)
    await projection.prefixEntered.promise

    await expect(
      runtime.request('runtime.tasks.transcript', {
        taskId: created.taskId,
        deviceId: 'local',
        threadId,
        workspacePath: '/workspace',
      })
    ).resolves.toMatchObject({ taskId: created.taskId })
    expect(readClient.requests.some(request => request.method === 'thread/read/indexed')).toBe(true)
    expect(liveClient.requests.some(request => request.method === 'thread/read/indexed')).toBe(false)
  } finally {
    projection?.releasePrefix.resolve()
    projection?.releaseLater.resolve()
    await runtime.notificationQueueByClient.get(liveClient)?.catch(() => undefined)
    await runtime.disposeAsync()
  }
})
