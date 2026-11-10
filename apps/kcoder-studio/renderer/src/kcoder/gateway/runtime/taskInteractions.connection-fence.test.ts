import { expect, test, vi } from 'vitest'
import { captureTaskInteraction, readTaskInteractions, respondTaskInteraction } from './taskInteractions'
import { respondToTaskQuestion } from './interactions'
import type { GatewayRuntimeCore } from './core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => {}) }))

async function fixture() {
  let connectionId = 'original-connection'
  const taskId = 'original-task', requestId = 2000001
  const frame = { serverId: 'native', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const status = async (_method: string, selector: object) => ({ ...selector, status: 'pending' })
  const client = {
    get diagnosticConnection() { return { connectionId } },
    supportsExperimental: () => true,
    request: vi.fn(status),
    requestOnConnection: vi.fn(async (expected: string, method: string, selector: object) => {
      if (expected !== connectionId) throw new Error('connection changed')
      return status(method, selector)
    }),
    respond: vi.fn(),
  }
  const pending = { client, taskId, requestId, turnId: frame.turnId, questionId: 'question',
    block: { id: 'block' }, renderPayload: { questions: [{ id: 'choice', header: 'Mode',
      question: 'Which mode?', isOther: false, options: [{ label: 'Continue', description: 'Original task' }] }] } }
  const task = { taskId, serverId: 'target', threadId: frame.threadId, workspacePath: '/owned',
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: 'target', transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const runtime = { disposed: false, tasks: new Map([[taskId, task]]), clientByTask: new Map([[taskId, client]]),
    threadByTask: new Map([[taskId, frame.threadId]]), appServerDisconnectedClients: new WeakSet(),
    activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    pendingQuestionByKey: new Map([[`${taskId}\0${requestId}`, pending]]),
    taskDescriptor: async () => ({ taskId, task, server }), serverForParams: vi.fn(async () => server),
    assertCommandTarget: vi.fn(async () => undefined),
    respondToTaskQuestion: (id, response, expected) => respondToTaskQuestion.call(core, id, response, expected),
  }
  const core = runtime as unknown as GatewayRuntimeCore
  const address = { taskId, deviceId: 'target', threadId: frame.threadId, workspacePath: '/owned' }
  const capture = () => captureTaskInteraction(core, client as never, taskId, frame, requestId)
  await capture()
  const reference = (await readTaskInteractions(core, { address })).items[0].reference
  client.request.mockClear()
  client.requestOnConnection.mockClear()
  const answer = () => respondTaskInteraction(core, { address, response: {
    reference, answers: { choice: { answers: ['Continue'] } },
  } })
  const reconnect = () => { connectionId = 'replacement-connection' }
  return { core, runtime, client, pending, taskId, requestId, address, reference, server, capture, answer, reconnect }
}

test('native status reads use the captured connection without opening a replacement socket', async () => {
  const f = await fixture()
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({ items: [{ state: 'pending' }] })
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.client.requestOnConnection).toHaveBeenCalledWith('original-connection', 'interaction/status/read', f.reference.selector, undefined)
})

test('the same client object on a replacement connection cannot revive the old card', async () => {
  const f = await fixture()
  f.reconnect()
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({ observationState: 'unknown', items: [] })
  await expect(f.answer()).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.client.requestOnConnection).not.toHaveBeenCalled()
  expect(f.client.respond).not.toHaveBeenCalled()
  expect(f.pending).not.toHaveProperty('responsePending')
})

test.each([1, 2, 3])('answer refuses a reconnected client during target lookup %s', async at => {
  const f = await fixture()
  for (let i = 1; i < at; i++) f.runtime.serverForParams.mockResolvedValueOnce(f.server)
  let release!: () => void
  f.runtime.serverForParams.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(f.server) }))
  const answering = f.answer()
  const rejected = expect(answering).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  f.reconnect()
  release()
  await rejected
  expect(f.client.respond).not.toHaveBeenCalled()
  expect(f.pending).not.toHaveProperty('responsePending')
})

test('a new authoritative request can recapture the original reference after reconnect', async () => {
  const f = await fixture()
  f.reconnect()
  f.runtime.pendingQuestionByKey.set(`${f.taskId}\0${f.requestId}`, { ...f.pending })
  await f.capture()
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({ items: [{ state: 'pending' }] })
  expect(await f.answer()).toMatchObject({ state: 'response_pending' })
  expect(f.client.respond).toHaveBeenCalledOnce()
})

test('a reconnect during native capture cannot register an old connection as current', async () => {
  const f = await fixture()
  const requestId = f.requestId + 1
  f.runtime.pendingQuestionByKey.set(`${f.taskId}\0${requestId}`, { ...f.pending, requestId, questionId: 'second-question' })
  let release!: () => void
  f.runtime.serverForParams.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(f.server) }))
  const capturing = captureTaskInteraction(f.core, f.client as never, f.taskId, f.reference.selector, requestId)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  f.reconnect()
  release()
  await capturing
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
    observationState: 'unknown', originalViewRequired: true, items: [],
  })
  expect(f.client.requestOnConnection).not.toHaveBeenCalled()
})

test('a native status receipt from the old connection cannot publish after reconnect', async () => {
  const f = await fixture()
  let release!: () => void
  f.client.requestOnConnection.mockImplementationOnce((_expected, _method, selector) => new Promise(resolve => {
    release = () => resolve({ ...selector, status: 'pending' })
  }))
  const reading = readTaskInteractions(f.core, { address: f.address })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  f.reconnect()
  release()
  expect(await reading).toMatchObject({ observationState: 'unknown', items: [] })
  expect(f.client.respond).not.toHaveBeenCalled()
})

test.each(['pending-receipt', 'lost-send'] as const)('recapture preserves %s instead of sending the answer again', async outcome => {
  const f = await fixture()
  if (outcome === 'lost-send') f.client.respond.mockImplementationOnce(() => { throw new Error('lost receipt') })
  expect(await f.answer()).toMatchObject({ state: outcome === 'lost-send' ? 'unknown' : 'response_pending' })
  f.reconnect()
  // A native replay is a fresh pending projection, without the old UI marker.
  f.runtime.pendingQuestionByKey.set(`${f.taskId}\0${f.requestId}`, { ...f.pending, responsePending: false } as never)
  await f.capture()
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({ items: [{ state: 'unknown' }] })
  expect(await f.answer()).toMatchObject({ state: 'unknown' })
  expect(f.client.respond).toHaveBeenCalledOnce()
})
