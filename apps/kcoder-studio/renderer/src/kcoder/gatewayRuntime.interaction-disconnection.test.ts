import { expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

async function fixture(kind: 'question' | 'approval') {
  const client = new FakeGatewayClient('disconnect-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'disconnect-draft', executionRequest: { prompt: 'controlled task' },
  }) as { taskId: string }
  const requestId = 1_000_000
  const dispatch = (autoResolutionMs?: number) => client.dispatchEvent(new CustomEvent('request', { detail: {
    id: requestId, method: `${kind}/request`, params: {
      threadId: 'disconnect-thread', turnId: 'disconnect-turn', appServerEpoch: 'disconnect-epoch',
      ...(kind === 'question'
        ? { questionId: 'original-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
        : { approvalId: 'original-approval', action: { type: 'command', command: 'echo controlled' } }),
      ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
    },
  } }))
  const reply = () => runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: {
      requestId, itemId: `original-${kind}`, answers: { choice: { answers: ['Allow once'] } },
    },
  })
  return { runtime, client, dispatch, reply, key: `${taskId}\0${requestId}` }
}

test.each(['question', 'approval'] as const)(
  '%s reply is refused immediately on app-server loss while notification cleanup is queued',
  async kind => {
    const f = await fixture(kind)
    f.dispatch()
    await vi.waitFor(() => expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true))
    await Promise.all([...f.runtime.pendingAsyncJobs])
    const pending = f.runtime.pendingQuestionByKey.get(f.key)!
    let release!: () => void
    f.runtime.notificationQueueByClient.set(f.client, new Promise(resolve => { release = resolve }))
    try {
      // The Gateway socket remains open; the registered listener fences loss
      // synchronously, before ordered cleanup can run behind another event.
      f.client.emitNotification('server/disconnected', {})
      expect(f.runtime.appServerDisconnectedClients.has(f.client)).toBe(true)
      expect(await f.reply()).toMatchObject({ accepted: false, code: 'original_interaction_changed' })
      expect(f.client.responses).toEqual([])
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
      expect(pending.responsePending).not.toBe(true)
      expect(pending.submittedResponse).toBeUndefined()
    } finally {
      release()
      await Promise.all([...f.runtime.pendingAsyncJobs])
    }
  }
)

test('an automatic question timer cannot answer after app-server loss', async () => {
  const f = await fixture('question')
  let release!: () => void
  vi.useFakeTimers()
  try {
    f.dispatch(1_000)
    await vi.waitFor(() => expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true))
    await Promise.all([...f.runtime.pendingAsyncJobs])
    const pending = f.runtime.pendingQuestionByKey.get(f.key)!
    f.runtime.notificationQueueByClient.set(f.client, new Promise(resolve => { release = resolve }))
    f.client.emitNotification('server/disconnected', {})
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.client.responses).toEqual([])
    expect(pending.responsePending).not.toBe(true)
    expect(pending.submittedResponse).toBeUndefined()
  } finally {
    release?.()
    vi.useRealTimers()
    await Promise.all([...f.runtime.pendingAsyncJobs])
  }
})

test.each(['question', 'approval'] as const)(
  '%s already queued before app-server loss cannot publish an actionable card afterward',
  async kind => {
    const f = await fixture(kind)
    let release!: () => void
    f.runtime.notificationQueueByClient.set(f.client, new Promise(resolve => { release = resolve }))
    try {
      f.dispatch()
      f.client.emitNotification('server/disconnected', {})
    } finally { release() }
    await Promise.all([...f.runtime.pendingAsyncJobs])
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    expect(f.client.responses).toEqual([])
  }
)
