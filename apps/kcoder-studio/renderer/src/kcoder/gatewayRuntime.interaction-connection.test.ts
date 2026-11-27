import { expect, test, vi } from 'vitest'
import * as gatewayServiceBridge from './gatewayServiceBridge'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

async function fixture(kind: 'question' | 'approval') {
  let connectionId = 'original-connection'
  const client = new FakeGatewayClient('original-thread')
  Object.defineProperty(client, 'diagnosticConnection', {
    get: () => ({ targetId: 'local', connectionId }),
  })
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'connection-draft', executionRequest: { prompt: 'controlled task' },
  }) as { taskId: string }
  const emit = vi.spyOn(gatewayServiceBridge, 'emitRuntimeEvent')
  const events = () => emit.mock.calls.map(([, event]) => (event as { event: string }).event)
  const requestId = 1_000_000
  const message = { id: requestId, method: `${kind}/request`, params: {
    threadId: 'original-thread', turnId: 'original-turn', appServerEpoch: 'original-epoch',
    ...(kind === 'question'
      ? { questionId: 'original-question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
      : { approvalId: 'original-approval', action: { type: 'command', command: 'echo controlled' } }),
  } }
  const dispatch = () => client.dispatchEvent(new CustomEvent('request', { detail: message }))
  const flush = () => Promise.all([...runtime.pendingAsyncJobs])
  const send = () => runtime.request('runtime.tasks.send', { taskId,
    requestUserInputResponse: { requestId, itemId: `original-${kind}`,
      answers: { [kind === 'question' ? 'choice' : 'original-approval']: { answers: ['Allow once'] } } },
  })
  return { runtime, client, message, dispatch, flush, send, events, key: `${taskId}\0${requestId}`,
    reconnect: () => { connectionId = 'replacement-connection' } }
}

test.each(['question', 'approval'] as const)('%s cannot send an old card on a replacement connection', async kind => {
  const f = await fixture(kind)
  f.dispatch(); await f.flush()
  const pending = f.runtime.pendingQuestionByKey.get(f.key)
  expect(pending).toBeDefined()
  f.reconnect()
  expect(await f.send()).toMatchObject({ accepted: false, code: 'original_interaction_changed' })
  expect(f.client.responses).toEqual([])
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(pending?.responsePending).not.toBe(true)
})

test.each(['question', 'approval'] as const)('%s queued before reconnect cannot bind to the new connection', async kind => {
  const f = await fixture(kind)
  let release!: () => void
  f.runtime.notificationQueueByClient.set(f.client, new Promise<void>(resolve => { release = resolve }))
  f.dispatch()
  f.reconnect()
  release()
  await f.flush()
  expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
  expect(f.client.responses).toEqual([])
  expect(f.events()).not.toContain('response.block.created')
})

test.each(['question', 'approval'] as const)('%s capture cannot publish a pending card after reconnect', async kind => {
  const f = await fixture(kind)
  const forwarding = f.runtime.forwardServerRequest(f.client, f.message, 'local')
  expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true)
  f.reconnect()
  await forwarding
  expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
  expect(f.client.responses).toEqual([])
  expect(f.events()).not.toContain('response.block.created')
})

test.each(['question', 'approval'] as const)('%s authoritative replay can renew an unsent original card', async kind => {
  const f = await fixture(kind)
  f.dispatch(); await f.flush()
  const pending = f.runtime.pendingQuestionByKey.get(f.key)
  f.reconnect()
  f.dispatch(); await f.flush()
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(await f.send()).toMatchObject({ accepted: true, pendingServerConfirmation: true })
  expect(f.client.responses).toHaveLength(1)
  expect(f.events().filter(event => event === 'response.block.created')).toHaveLength(1)
})

test.each(['question', 'approval'] as const)('%s replay after reconnect preserves an answer awaiting confirmation', async kind => {
  const f = await fixture(kind)
  f.dispatch(); await f.flush()
  expect(await f.send()).toMatchObject({ accepted: true })
  const pending = f.runtime.pendingQuestionByKey.get(f.key)
  f.reconnect()
  f.dispatch(); await f.flush()
  expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
  expect(await f.send()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
  expect(f.client.responses).toHaveLength(1)
})

test('an old request failure cannot send an error to its reused ID on a replacement connection', async () => {
  const f = await fixture('question')
  let fail!: () => void
  vi.spyOn(f.runtime, 'forwardServerRequest').mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error('original request projection failed'))
  }))
  f.dispatch()
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
  f.reconnect()
  fail()
  await f.flush()
  expect(f.client.responses).toEqual([])
  expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
})
