import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionReferenceV1 } from '../../../shared/generated/contracts'
import { createTaskInteractionTransport } from './taskInteractionTransport'

const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))

const address = {
  deviceId: 'native', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/owned',
}

afterEach(() => f.request.mockReset())

for (const kind of ['question', 'approval'] as const) {
  for (const receiptMatchesOriginal of [true, false]) {
    test(`${kind} binds its receipt to the dispatched reference when the caller changes it (${receiptMatchesOriginal ? 'original' : 'changed'} receipt)`, async () => {
      const reference: TaskInteractionReferenceV1 = {
        attemptId: 'original-attempt',
        selector: {
          serverId: 'native-process', threadId: address.threadId, turnId: 'original-turn',
          requestId: 2000001, appServerEpoch: 'original-epoch', kind,
          ...(kind === 'question' ? { questionId: 'original-question' } : { approvalId: 'original-approval' }),
        },
      }
      const original = structuredClone(reference)
      let finish!: (value: unknown) => void
      f.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      const transport = createTaskInteractionTransport(address, () => true)
      const response = { requestId: reference.selector.requestId, answers: { choice: { answers: ['Continue'] } } }
      try {
        const answering = transport.respond(reference, response)
        // Observe rejection immediately so a failing regression has no unhandled promise.
        const outcome = answering.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
        expect(f.request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.interactions.respond', {
          address, response: { reference: original, answers: response.answers },
        }, { signal: expect.any(AbortSignal) })

        reference.attemptId = 'later-attempt'
        reference.selector.requestId++
        reference.selector.turnId = 'later-turn'
        reference.selector.appServerEpoch = 'later-epoch'
        if (kind === 'question') reference.selector.questionId = 'later-question'
        else reference.selector.approvalId = 'later-approval'

        const receipt = { reference: structuredClone(receiptMatchesOriginal ? original : reference), state: 'response_pending' }
        finish(receipt)
        const result = await outcome
        if (receiptMatchesOriginal) {
          expect(result.error).toBeUndefined()
          expect(result.value).toEqual(receipt)
        } else {
          expect(result.error).toMatchObject({ code: 'outcome_unknown' })
          expect(result.value).toBeUndefined()
        }
        expect(f.request).toHaveBeenCalledTimes(1)
      } finally {
        transport.dispose()
      }
    })
  }
}
