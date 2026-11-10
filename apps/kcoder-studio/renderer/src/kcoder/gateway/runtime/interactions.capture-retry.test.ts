import { expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import { readTaskInteractions, respondTaskInteraction } from './taskInteractions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

function fixture(kind: 'question' | 'approval') {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const frame = { serverId: 'native', threadId, turnId, appServerEpoch: 'epoch' }
  const client = { supportsExperimental: () => true, respond: vi.fn(), respondError: vi.fn(),
    request: vi.fn(async (_method: string, selector: object) => ({ ...selector, status: 'pending' })) }
  const task = { taskId, serverId: 'target', threadId, workspacePath: '/owned',
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: 'target', transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const runtime = { disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, task]]), taskByThread: new Map([['target\0thread', taskId]]),
    threadByTask: new Map([[taskId, threadId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
    activeTurnByTask: new Map([[taskId, { turnId }]]), turnAttemptIds: new Map([[`${taskId}:${turnId}`, 'attempt']]),
    serverForParams: vi.fn(async () => server), assertCommandTarget: vi.fn(async () => undefined),
    taskDescriptor: async () => ({ taskId, task, server }), forwardApprovalRequest,
    respondToTaskQuestion: (id, response, expected) => respondToTaskQuestion.call(core, id, response, expected),
  }
  const core = runtime as unknown as GatewayRuntimeCore
  const params = { ...frame, ...(kind === 'question'
    ? { questionId: 'question', questions: [{ id: 'choice', header: 'Continue', prompt: 'Continue?',
        allowsFreeform: false, options: [{ label: 'Continue', description: 'Original task' }] }] }
    : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }) }
  const start = () => forwardServerRequest.call(core, client as never,
    { id: requestId, method: `${kind}/request`, params }, 'target')
  const address = { taskId, deviceId: 'target', threadId, workspacePath: '/owned' }
  const read = () => readTaskInteractions(core, { address })
  return { runtime, core, client, start, read, address, key: `${taskId}\0${requestId}` }
}

test.each(['question', 'approval'] as const)('%s replay retries a failed projection capture without duplicating the card', async kind => {
  const f = fixture(kind)
  f.runtime.serverForParams.mockRejectedValueOnce(new Error('target directory temporarily unavailable'))
  vi.mocked(emitRuntimeEvent).mockClear()
  await f.start()
  const pending = f.runtime.pendingQuestionByKey.get(f.key)
  expect(pending).toBeDefined()
  expect(await f.read()).toMatchObject({ observationState: 'unknown', originalViewRequired: true, items: [] })
  await f.start()
  const snapshot = await f.read()
  expect(snapshot).toMatchObject({ observationState: 'observed', items: [{ state: 'pending' }] })
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  const itemId = kind === 'question' ? 'choice' : 'approval'
  const result = await respondTaskInteraction(f.core, { address: f.address, response: {
    reference: snapshot.items[0].reference, answers: { [itemId]: { answers: [kind === 'question' ? 'Continue' : 'Allow once'] } },
  } })
  expect(result.state).toBe('response_pending')
  expect(f.client.respond).toHaveBeenCalledOnce()
  // Replaying a submitted request must retain its original answer guard.
  await f.start()
  expect((await f.read()).items[0].state).toBe('response_pending')
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(f.client.respond).toHaveBeenCalledOnce()
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
})

test.each(['question', 'approval'] as const)('%s replay recovers a failed card publication without replaying an answer', async kind => {
  const f = fixture(kind)
  vi.mocked(emitRuntimeEvent).mockClear()
  vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('question listener temporarily unavailable'))
  await expect(f.start()).rejects.toThrow('question listener temporarily unavailable')
  const pending = f.runtime.pendingQuestionByKey.get(f.key)
  expect(pending).toBeDefined()

  await f.start()
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
  expect(vi.mocked(emitRuntimeEvent).mock.calls[1]).toEqual(vi.mocked(emitRuntimeEvent).mock.calls[0])
  expect((await f.read()).items[0].state).toBe('pending')
  expect(f.client.respond).not.toHaveBeenCalled()

  await f.start()
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
  expect(f.client.respond).not.toHaveBeenCalled()
})

test.each(['question', 'approval'] as const)('%s overlapping replays share the original pending card publication', async kind => {
  const f = fixture(kind)
  vi.mocked(emitRuntimeEvent).mockClear()
  let finish!: () => void
  vi.mocked(emitRuntimeEvent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const original = f.start()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const replay = f.start()
  await vi.waitFor(() => expect(f.runtime.serverForParams).toHaveBeenCalledTimes(2))
  finish()
  await Promise.all([original, replay])
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  expect(f.client.respond).not.toHaveBeenCalled()
})

test.each(['question', 'approval'] as const)('%s answered through the task space cannot reopen a failed original card', async kind => {
  const f = fixture(kind)
  vi.mocked(emitRuntimeEvent).mockClear()
  vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('question listener temporarily unavailable'))
  await expect(f.start()).rejects.toThrow('question listener temporarily unavailable')
  const snapshot = await f.read()
  const itemId = kind === 'question' ? 'choice' : 'approval'
  expect(await respondTaskInteraction(f.core, { address: f.address, response: {
    reference: snapshot.items[0].reference,
    answers: { [itemId]: { answers: [kind === 'question' ? 'Continue' : 'Allow once'] } },
  } })).toHaveProperty('state', 'response_pending')

  await f.start()
  expect((await f.read()).items[0].state).toBe('response_pending')
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  expect(f.client.respond).toHaveBeenCalledOnce()
})
