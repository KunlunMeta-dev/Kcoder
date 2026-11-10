import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionReferenceV1 } from '../../../shared/generated/contracts'
import { createTaskInteractionTransport } from './taskInteractionTransport'

const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))

const address = {
  deviceId: 'native', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/owned',
}
const answers = { choice: { answers: ['Continue'] } }
afterEach(() => f.request.mockReset())

for (const kind of ['question', 'approval'] as const) {
  const reference: TaskInteractionReferenceV1 = {
    attemptId: 'original-attempt',
    selector: {
      serverId: 'native-process', threadId: address.threadId, turnId: 'original-turn',
      requestId: 2000001, appServerEpoch: 'original-epoch', kind,
      ...(kind === 'question' ? { questionId: 'original-question' } : { approvalId: 'original-approval' }),
    },
  }
  const itemId = reference.selector.questionId ?? reference.selector.approvalId!

  for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
    test.each(['foreign-identity', '', null, 7])(
      `${kind} rejects explicit ${field}=%j before projecting answers`, async value => {
        f.request.mockResolvedValue({ reference, state: 'response_pending' })
        const transport = createTaskInteractionTransport(address, () => true)
        try {
          await expect(transport.respond(reference, {
            requestId: reference.selector.requestId, itemId, answers, [field]: value,
          })).rejects.toMatchObject({ code: 'invalid_reply' })
          expect(f.request).not.toHaveBeenCalled()
          // A local rejection does not consume the original card's reply path.
          await expect(transport.respond(reference, {
            requestId: reference.selector.requestId, itemId, answers,
            threadId: reference.selector.threadId, turnId: reference.selector.turnId,
            appServerEpoch: reference.selector.appServerEpoch,
          })).resolves.toMatchObject({ state: 'response_pending' })
          expect(f.request).toHaveBeenCalledOnce()
        } finally { transport.dispose() }
      },
    )
  }

  for (const identity of [
    { requestId: reference.selector.requestId, request_id: 'another-request' },
    { requestId: 'another-request', request_id: reference.selector.requestId },
    { requestId: reference.selector.requestId, request_id: null },
    { requestId: null, request_id: reference.selector.requestId },
  ]) {
    test(`${kind} rejects conflicting request aliases before projecting answers: ${JSON.stringify(identity)}`, async () => {
      f.request.mockResolvedValue({ reference, state: 'response_pending' })
      const transport = createTaskInteractionTransport(address, () => true)
      try {
        await expect(transport.respond(reference, { answers, ...identity }))
          .rejects.toMatchObject({ code: 'invalid_reply' })
        expect(f.request).not.toHaveBeenCalled()
      } finally { transport.dispose() }
    })
  }

  test(`${kind} accepts equivalent numeric and legacy string request aliases`, async () => {
    const receipt = { reference, state: 'response_pending' }
    f.request.mockResolvedValue(receipt)
    const transport = createTaskInteractionTransport(address, () => true)
    try {
      await expect(transport.respond(reference, {
        requestId: reference.selector.requestId, request_id: String(reference.selector.requestId), answers,
      })).resolves.toEqual(receipt)
      expect(f.request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.interactions.respond', {
        address, response: { reference, answers },
      }, { signal: expect.any(AbortSignal) })
    } finally { transport.dispose() }
  })

  for (const identity of [
    { itemId: 'another-interaction' },
    { item_id: 'another-interaction' },
    { itemId, item_id: 'another-interaction' },
    { itemId: 'another-interaction', item_id: itemId },
    { sourceAgent: { parentSessionId: address.threadId, agentId: 'another-agent' } },
  ]) {
    test(`${kind} rejects a foreign answer sharing its transport request ID: ${JSON.stringify(identity)}`, async () => {
      f.request.mockResolvedValue({ reference, state: 'response_pending' })
      const transport = createTaskInteractionTransport(address, () => true)
      try {
        await expect(transport.respond(reference, {
          requestId: reference.selector.requestId, answers, ...identity,
        })).rejects.toMatchObject({ code: 'invalid_reply' })
        expect(f.request).not.toHaveBeenCalled()
      } finally { transport.dispose() }
    })
  }

  for (const identity of [{ itemId }, { item_id: itemId }, {}]) {
    test(`${kind} preserves matching and omitted legacy item identities: ${JSON.stringify(identity)}`, async () => {
      const receipt = { reference, state: 'response_pending' }
      f.request.mockResolvedValue(receipt)
      const transport = createTaskInteractionTransport(address, () => true)
      try {
        await expect(transport.respond(reference, {
          request_id: String(reference.selector.requestId), answers, ...identity,
        })).resolves.toEqual(receipt)
        expect(f.request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.interactions.respond', {
          address, response: { reference, answers },
        }, { signal: expect.any(AbortSignal) })
      } finally { transport.dispose() }
    })
  }
}
