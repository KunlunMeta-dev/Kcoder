import { listen } from '@/lib/runtime-events'
import { expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

async function fixture(kind: 'question' | 'approval') {
  const client = new FakeGatewayClient('replay-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'replay-draft', executionRequest: { prompt: 'controlled task' },
  }) as { taskId: string }
  const requestId = 1_000_000
  const params = {
    threadId: 'replay-thread', turnId: 'replay-turn', appServerEpoch: 'replay-epoch',
    ...(kind === 'question'
      ? { questionId: 'original-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
      : { approvalId: 'original-approval', action: { type: 'command', command: 'echo controlled' } }),
  }
  const dispatch = async (patch = {}) => {
    client.dispatchEvent(new CustomEvent('request', {
      detail: { id: requestId, method: `${kind}/request`, params: { ...params, ...patch } },
    }))
    await Promise.all([...runtime.pendingAsyncJobs])
  }
  const send = () => runtime.request('runtime.tasks.send', {
    taskId,
    requestUserInputResponse: {
      requestId, itemId: `original-${kind}`, answers: { [kind === 'question' ? 'choice' : 'original-approval']: { answers: ['Allow once'] } },
    },
  })
  return { client, runtime, taskId, requestId, dispatch, send, key: `${taskId}\0${requestId}` }
}

test.each(['question', 'approval'] as const)(
  '%s replay preserves the original pending object and publishes only one card', async kind => {
    const f = await fixture(kind)
    const events: string[] = []
    const stop = await listen<{ event: string }>('local-executor:event', event => events.push(event.payload.event))
    try {
      await f.dispatch()
      const original = f.runtime.pendingQuestionByKey.get(f.key)
      await f.dispatch()
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(original)
      expect(events.filter(event => event === 'response.block.created')).toHaveLength(1)
      expect(f.client.responses).toEqual([])
    } finally {
      stop()
    }
  }
)

test.each([
  ['question', 'replay-epoch'], ['approval', 'replay-epoch'],
  ['question', undefined], ['approval', undefined],
] as const)(
  '%s replay while awaiting confirmation cannot resend the answer (epoch: %s)', async (kind, appServerEpoch) => {
    const f = await fixture(kind)
    await f.dispatch({ appServerEpoch })
    expect(await f.send()).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    await f.dispatch({ appServerEpoch })
    expect(await f.send()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    expect(f.client.responses).toHaveLength(1)
  }
)

test.each(['question', 'approval'] as const)(
  '%s duplicate received during capture retains one original publication', async kind => {
    const f = await fixture(kind)
    const events: string[] = []
    const stop = await listen<{ event: string }>('local-executor:event', event => events.push(event.payload.event))
    try {
      await Promise.all([f.dispatch(), f.dispatch()])
      expect(events.filter(event => event === 'response.block.created')).toHaveLength(1)
      expect(await f.send()).toMatchObject({ accepted: true })
      expect(f.client.responses).toHaveLength(1)
    } finally {
      stop()
    }
  }
)

test('a replay cannot restart the original question timeout', async () => {
  const f = await fixture('question')
  vi.useFakeTimers()
  try {
    await f.dispatch({ autoResolutionMs: 1_000 })
    const original = f.runtime.pendingQuestionByKey.get(f.key)!
    await vi.advanceTimersByTimeAsync(500)
    await f.dispatch({ autoResolutionMs: 2_000 })
    await vi.advanceTimersByTimeAsync(500)
    expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(original)
    expect(original.responsePending).toBe(true)
    expect(f.client.responses).toEqual([{
      id: f.requestId,
      result: expect.objectContaining({ annotations: { autoResolved: true } }),
    }])
  } finally {
    vi.useRealTimers()
  }
})

test.each(['question', 'approval'] as const)(
  '%s request from a replaced client cannot erase the current pending interaction', async kind => {
    const f = await fixture(kind)
    const replacement = new FakeGatewayClient('replay-thread')
    f.runtime.clientByTask.set(f.taskId, replacement)
    const current = {
      client: replacement, requestId: f.requestId, taskId: f.taskId, turnId: 'current-turn',
      questionId: 'current-question', block: { id: 'current-block' }, renderPayload: {},
    }
    f.runtime.pendingQuestionByKey.set(f.key, current)
    await f.dispatch()
    expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(current)
    expect(replacement.responses).toEqual([])
  }
)
