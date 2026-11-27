import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionReferenceV1, TaskInteractionSnapshotV1 } from '../../../shared/generated/contracts'
import { createTaskInteractionTransport } from './taskInteractionTransport'
import { notifyAccountContextChange } from './accountContextEvents'

const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))

const address = {
  deviceId: 'native', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/owned',
}
const reference: TaskInteractionReferenceV1 = {
  attemptId: 'original-attempt',
  selector: {
    serverId: 'native-process', threadId: address.threadId, turnId: 'original-turn',
    requestId: 2000001, appServerEpoch: 'original-epoch', kind: 'question',
    questionId: 'original-question',
  },
}
const snapshot: TaskInteractionSnapshotV1 = {
  schemaVersion: 1, threadId: address.threadId, observationState: 'observed',
  items: [{
    reference, state: 'pending', presentation: {
      approval: null,
      questions: [{ id: 'choice', header: 'Original source', question: 'Which source should the original task use?',
        isOther: false, options: [{ label: 'Continue', description: 'Use the original source' }] }],
    },
  }],
}

afterEach(() => f.request.mockReset())

for (const operation of ['read', 'respond'] as const) {
  for (const change of ['target', 'account', 'dispose', 'abort'] as const) {
    test(`${operation} fences a ${change} change between executor completion and the public continuation`, async () => {
      let finish!: (value: unknown) => void
      f.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      let current = true
      const transport = createTaskInteractionTransport(address, () => current)
      const abort = new AbortController()
      try {
        const request = operation === 'read'
          ? transport.read(abort.signal)
          : transport.respond(reference, {
              requestId: reference.selector.requestId, answers: { choice: { answers: ['Continue'] } },
            }, abort.signal)
        // Observe the result before releasing the executor to retain failures
        // without creating an unhandled rejection in the regression itself.
        const outcome = request.then(value => ({ value, error: undefined }),
          error => ({ value: undefined, error }))
        expect(f.request).toHaveBeenCalledTimes(1)
        finish(operation === 'read'
          ? structuredClone(snapshot)
          : { reference: structuredClone(reference), state: 'response_pending' })
        // The executor's await runs first and validates its owner. The caller's
        // await resumes after this already-queued task/transport lifecycle event.
        queueMicrotask(() => {
          if (change === 'target') current = false
          else if (change === 'account') notifyAccountContextChange(address.deviceId)
          else if (change === 'dispose') transport.dispose()
          else abort.abort()
        })
        const result = await outcome
        expect(result.error).toMatchObject({ code: operation === 'respond'
          ? 'outcome_unknown' : change === 'abort' ? 'cancelled' : 'scope_changed' })
        expect(result.value).toBeUndefined()
        // A lost confirmation must never trigger a second answer or a new read.
        expect(f.request).toHaveBeenCalledTimes(1)
      } finally {
        transport.dispose()
      }
    })
  }

  test(`${operation} returns a current result without replay or a spurious lifecycle error`, async () => {
    const receipt = operation === 'read'
      ? structuredClone(snapshot)
      : { reference: structuredClone(reference), state: 'response_pending' }
    f.request.mockResolvedValueOnce(receipt)
    const transport = createTaskInteractionTransport(address, () => true)
    try {
      const result = operation === 'read'
        ? await transport.read()
        : await transport.respond(reference, {
            requestId: reference.selector.requestId, answers: { choice: { answers: ['Continue'] } },
          })
      expect(result).toEqual(receipt)
      expect(f.request).toHaveBeenCalledTimes(1)
    } finally {
      transport.dispose()
    }
  })
}
