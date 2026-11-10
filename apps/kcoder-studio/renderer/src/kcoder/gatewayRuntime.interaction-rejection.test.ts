import { listen } from '@/lib/runtime-events'
import { expect, test, vi } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { applyRequestUserInputResponseToMessages } from '@/components/chat/requestUserInputMessages'
import { createRuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import type { RequestUserInputResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

async function fixture(kind: 'question' | 'approval', epoch: string | null = 'epoch', autoResolutionMs?: number) {
  const client = new FakeGatewayClient('rejection-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'rejection-draft', executionRequest: { prompt: 'controlled task' },
  }) as { taskId: string }
  const requestId = 1_000_000
  const binding = {
    threadId: 'rejection-thread', turnId: 'rejection-turn', appServerEpoch: epoch ?? undefined,
    ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }),
  }
  client.dispatchEvent(new CustomEvent('request', { detail: {
    id: requestId, method: `${kind}/request`, params: {
      ...binding,
      ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
      ...(kind === 'question'
        ? { questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
        : { action: { type: 'command', command: 'echo controlled' } }),
    },
  } }))
  await Promise.all([...runtime.pendingAsyncJobs])
  const send = () => runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: {
      requestId, itemId: kind, answers: { [kind === 'question' ? 'choice' : 'approval']: { answers: ['Allow once'] } },
    },
  })
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  const reject = async (patch: Record<string, unknown> = {}) => {
    client.emitNotification('gateway/interaction/replyRejected', JSON.parse(JSON.stringify({
      ...binding, requestId, reason: 'not_original_client', ...patch,
    })))
    await Promise.all([...runtime.pendingAsyncJobs])
  }
  return { client, runtime, taskId, requestId, binding, send, pending, reject }
}

for (const kind of ['question', 'approval'] as const) {
  test.each(['gateway/interaction/replyRejected', `${kind}/resolved`])(
    '%s queued on an old connection cannot settle a reconnected ' + kind,
    async method => {
      const f = await fixture(kind)
      let connection = { targetId: 'local', connectionId: 'rpc-1-1' }
      Object.defineProperty(f.client, 'diagnosticConnection', { get: () => connection })
      f.pending.connectionId = connection.connectionId
      await f.send()
      const answer = f.pending.submittedResponse
      const params = { ...f.binding, requestId: f.requestId, reason: 'invalid_response',
        serverId: 'native-process', sequence: 42 }
      // The listener captures this socket, but ordered projection runs later.
      f.client.emitNotification(method, params)
      connection = { ...connection, connectionId: 'rpc-1-2' }
      f.pending.connectionId = connection.connectionId
      await Promise.all([...f.runtime.pendingAsyncJobs])
      expect(f.runtime.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
      expect(f.pending.responsePending).toBe(true)
      expect(f.pending.submittedResponse).toBe(answer)
      expect(f.client.responses).toHaveLength(1)

      // A fresh notification from the current socket remains authoritative.
      f.client.emitNotification(method, params)
      await Promise.all([...f.runtime.pendingAsyncJobs])
      if (method === 'gateway/interaction/replyRejected') {
        expect(f.pending.responsePending).toBe(false)
        expect(f.pending.submittedResponse).toBeUndefined()
      } else {
        expect(f.runtime.pendingQuestionByKey.has(`${f.taskId}\0${f.requestId}`)).toBe(false)
      }
      expect(f.client.responses).toHaveLength(1)
    }
  )
}

test.each(['question', 'approval'] as const)(
  '%s rejected by the Gateway cannot confirm the losing client answer', async kind => {
    const f = await fixture(kind)
    expect(await f.send()).toMatchObject({ accepted: true })
    const events: unknown[] = []
    const stop = await listen('local-executor:event', event => events.push(event.payload))
    try {
      await f.reject()
      expect(f.pending.responsePending).toBe(false)
      expect(f.pending.submittedResponse).toBeUndefined()
      expect(f.runtime.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
      expect(events).toEqual([expect.objectContaining({
        event: 'response.block.updated',
        payload: expect.objectContaining({ data: expect.objectContaining({ updates: expect.objectContaining({
          status: 'error', renderPayload: f.pending.renderPayload, toolOutput: expect.any(String),
        }) }) }),
      })])
      f.client.emitNotification(`${kind}/resolved`, {
        ...f.binding, requestId: f.requestId, reason: 'client_response', decision: 'accept',
      })
      await Promise.all([...f.runtime.pendingAsyncJobs])
      expect(f.runtime.pendingQuestionByKey.size).toBe(0)
      expect(events.at(-1)).toMatchObject({
        event: 'response.block.updated', payload: { data: { updates: {
          status: 'done', toolOutput: expect.any(String),
        } } },
      })
      expect(events.at(-1)).not.toHaveProperty('payload.data.updates.renderPayload.response')
      expect(events.at(-1)).toHaveProperty('payload.data.updates.toolOutput', expect.not.stringContaining('Allow once'))
      expect(f.client.responses).toHaveLength(1)
    } finally { stop() }
  }
)

test.each(['question', 'approval'] as const)(
  '%s invalid response rejection releases the busy state without replaying input', async kind => {
    const f = await fixture(kind)
    await f.send()
    await f.reject({ reason: 'invalid_response' })
    expect(f.pending.responsePending).toBe(false)
    expect(f.client.responses).toHaveLength(1)
    expect(await f.send()).toMatchObject({ accepted: true })
    expect(f.client.responses).toHaveLength(2)
  }
)

for (const kind of ['question', 'approval'] as const) {
  test.each([
    { threadId: 'other-thread' }, { turnId: 'old-turn' }, { requestId: 1_000_001 },
    { appServerEpoch: 'old-epoch' }, { appServerEpoch: undefined },
    { [kind === 'question' ? 'questionId' : 'approvalId']: 'other-item' },
    { [kind === 'question' ? 'approvalId' : 'questionId']: 'foreign-kind' },
  ])(`${kind} stale or conflicting rejection preserves the dispatched answer %j`, async patch => {
    const f = await fixture(kind)
    await f.send()
    const answer = f.pending.submittedResponse
    await f.reject(patch)
    expect(f.pending.responsePending).toBe(true)
    expect(f.pending.submittedResponse).toBe(answer)
    expect(f.client.responses).toHaveLength(1)
  })
}

test.each(['question', 'approval'] as const)(
  '%s legacy unbound rejection still releases its unique original request', async kind => {
    const f = await fixture(kind)
    await f.send()
    await f.reject({ turnId: undefined, appServerEpoch: undefined,
      questionId: undefined, approvalId: undefined })
    expect(f.pending.responsePending).toBe(false)
    expect(f.pending.submittedResponse).toBeUndefined()
  }
)

test.each(['question', 'approval'] as const)(
  '%s rejection from a replaced task client cannot change the current answer', async kind => {
    const f = await fixture(kind)
    await f.send()
    f.runtime.clientByTask.set(f.taskId, new FakeGatewayClient('rejection-thread'))
    await f.reject()
    expect(f.pending.responsePending).toBe(true)
    expect(f.pending.submittedResponse).toBeDefined()
  }
)

test.each(['question', 'approval'] as const)(
  '%s rejection after app-server loss preserves the answer for recovery', async kind => {
    const f = await fixture(kind)
    await f.send()
    f.runtime.appServerDisconnectedClients.add(f.client)
    await f.reject()
    expect(f.pending.responsePending).toBe(true)
    expect(f.pending.submittedResponse).toBeDefined()
  }
)

test.each(['question', 'approval'] as const)(
  '%s bound legacy request without an epoch accepts only an epoch-free rejection', async kind => {
    const f = await fixture(kind, null)
    await f.send()
    await f.reject({ appServerEpoch: 'another-server' })
    expect(f.pending.responsePending).toBe(true)
    await f.reject()
    expect(f.pending.responsePending).toBe(false)
    expect(f.pending.submittedResponse).toBeUndefined()
  }
)

test.each(['question', 'approval'] as const)(
  '%s turn-ended rejection and duplicate cannot resend input or republish errors', async kind => {
    const f = await fixture(kind)
    await f.send()
    const events: unknown[] = []
    const stop = await listen('local-executor:event', event => events.push(event.payload))
    try {
      await f.reject({ reason: 'turn_ended' })
      await f.reject({ reason: 'turn_ended' })
      expect(f.pending.responsePending).toBe(false)
      expect(f.pending.submittedResponse).toBeUndefined()
      expect(f.client.responses).toHaveLength(1)
      expect(events).toHaveLength(1)
    } finally { stop() }
  }
)

test('a rejected automatic question cannot run its timer as a retry', async () => {
  vi.useFakeTimers()
  try {
    const f = await fixture('question', 'epoch', 1_000)
    expect(f.pending.autoResolutionTimer).toBeDefined()
    await f.send()
    await f.reject()
    expect(f.pending.autoResolutionTimer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.client.responses).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

test.each(['question', 'approval'] as const)(
  '%s unsolicited rejection cannot retire an unanswered card', async kind => {
    const f = await fixture(kind)
    const events: unknown[] = []
    const stop = await listen('local-executor:event', event => events.push(event.payload))
    try {
      await f.reject()
      expect(events).toEqual([])
      expect(f.pending.responsePending).toBeUndefined()
      expect(f.client.responses).toEqual([])
    } finally { stop() }
  }
)

test.each(['question', 'approval'] as const)(
  '%s conversation projection clears a rejected answer even when local acceptance arrives late', async kind => {
    const f = await fixture(kind)
    await f.send()
    const response = f.pending.submittedResponse as unknown as RequestUserInputResponse
    const original: WorkbenchMessage[] = [{
      id: 'assistant', taskId: f.taskId, role: 'assistant', content: '', status: 'streaming',
      subtaskId: f.binding.turnId, turnId: f.binding.turnId, attemptId: f.binding.turnId,
      createdAt: '2026-11-04T00:00:00Z', blocks: [{
        id: String(f.pending.block.id), type: 'tool', toolName: 'request_user_input',
        status: 'pending', renderPayload: f.pending.renderPayload,
      }],
    }]
    let messages = applyRequestUserInputResponseToMessages(original, response)
    expect(messages[0].blocks?.[0].renderPayload).toHaveProperty('response', response)
    const handlers = createRuntimeTaskStreamHandlers({
      runtime: 'kcoder', deviceId: 'local', taskId: f.taskId, threadId: f.binding.threadId,
    }, { onMessageAction: action => { messages = reduceWorkbenchMessages(messages, action) } })
    const stream = createResponseApiStreamState()
    const stop = await listen<{ event: string; payload: Record<string, unknown> }>(
      'local-executor:event', event => emitResponseApiEvent(
        handlers, event.payload.event, event.payload.payload, stream
      )
    )
    try {
      await f.reject()
      expect(messages[0].blocks?.[0]).toMatchObject({ status: 'error', toolOutput: expect.any(String) })
      expect(messages[0].blocks?.[0].renderPayload).not.toHaveProperty('response')
      // A send acknowledgement can settle after the rejection event was projected.
      expect(applyRequestUserInputResponseToMessages(messages, response)).toBe(messages)
      expect(messages[0].blocks?.[0].renderPayload).not.toHaveProperty('response')
    } finally { stop() }
  }
)
