import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionReferenceV1 } from '../../../shared/generated/contracts'
import { createTaskInteractionTransport } from './taskInteractionTransport'
import { captureTaskInteraction, respondTaskInteraction } from './gateway/runtime/taskInteractions'
import { respondToTaskQuestion } from './gateway/runtime/interactions'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('./gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => {}) }))

const address = {
  deviceId: 'native', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/owned',
}
const answers = { choice: { answers: ['Continue'] } }
afterEach(() => f.request.mockReset())

async function originalRuntime(reference: TaskInteractionReferenceV1) {
  const selector = reference.selector
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(async (_method: string, query: object) => ({ ...query, status: 'pending' })),
    respond: vi.fn(),
  }
  const task = { ...address, serverId: address.deviceId, runtimeHandle: { memoryTaskSnapshot: {
    threadId: address.threadId, turnId: selector.turnId, attemptId: reference.attemptId,
    serverInstanceId: selector.serverId,
  } } }
  const pending = {
    client, taskId: address.taskId, requestId: selector.requestId, turnId: selector.turnId,
    appServerEpoch: selector.appServerEpoch, block: { id: 'original-card' },
    ...(selector.kind === 'question' ? { questionId: selector.questionId } : {
      approvalId: selector.approvalId, approvalDecisions: { Continue: 'accept' },
    }),
    renderPayload: { questions: [{ id: 'choice', header: 'Original request', question: 'Continue?',
      isOther: false, options: [{ label: 'Continue', description: 'Original operation' }] }],
    ...(selector.kind === 'approval' ? { approvalPresentation: { kind: 'tool', subject: 'Bash' } } : {}) },
  }
  const server = { id: address.deviceId, transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[address.taskId, task]]), clientByTask: new Map([[address.taskId, client]]),
    threadByTask: new Map([[address.taskId, address.threadId]]),
    turnAttemptIds: new Map([[`${address.taskId}:${selector.turnId}`, reference.attemptId]]),
    activeTurnByTask: new Map([[address.taskId, { turnId: selector.turnId }]]),
    pendingQuestionByKey: new Map([[`${address.taskId}\0${selector.requestId}`, pending]]),
    taskDescriptor: async () => ({ taskId: address.taskId, task, server }),
    serverForParams: async () => server, assertCommandTarget: async () => {},
    respondToTaskQuestion: (taskId, response, expected) => respondToTaskQuestion.call(core, taskId, response, expected),
  }
  const core = runtime as unknown as GatewayRuntimeCore
  await captureTaskInteraction(core, client as never, address.taskId, selector, selector.requestId)
  f.request.mockImplementation((_method, params) => respondTaskInteraction(core, params))
  return client
}

for (const kind of ['question', 'approval'] as const) {
  const reference: TaskInteractionReferenceV1 = {
    attemptId: 'original-attempt',
    selector: {
      serverId: 'native-process', threadId: address.threadId, turnId: 'original-turn',
      requestId: 2000001, appServerEpoch: 'original-epoch', kind,
      ...(kind === 'question' ? { questionId: 'original-question' } : { approvalId: 'original-approval' }),
    },
  }
  for (const identity of [
    { requestId: '2000001' },
    { request_id: '2000001' },
    { requestId: reference.selector.requestId, request_id: '2000001' },
    { requestId: '2000001', request_id: reference.selector.requestId },
  ]) {
    test(`${kind} cannot project string request identity ${JSON.stringify(identity)} into a numeric waiter`, async () => {
      const client = await originalRuntime(reference)
      const transport = createTaskInteractionTransport(address, () => true)
      try {
        await expect(transport.respond(reference, { ...identity, answers }))
          .rejects.toMatchObject({ code: 'invalid_reply' })
        expect(f.request).not.toHaveBeenCalled()
        expect(client.respond).not.toHaveBeenCalled()
        // Reject locally without consuming the actual numeric card's answer.
        await expect(transport.respond(reference, {
          requestId: reference.selector.requestId, answers,
        })).resolves.toMatchObject({ state: 'response_pending' })
        expect(f.request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.interactions.respond', {
          address, response: { reference, answers },
        }, { signal: expect.any(AbortSignal) })
        expect(client.respond).toHaveBeenCalledExactlyOnceWith(reference.selector.requestId,
          expect.objectContaining(kind === 'approval' ? { decision: 'accept' } : { answers }))
      } finally { transport.dispose() }
    })
  }
}
