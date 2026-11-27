import { expect, test, vi } from 'vitest'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

async function fixture(availableDecisions: string[] | null | undefined) {
  const client = { supportsExperimental: () => true, respond: vi.fn() } as unknown as GatewayClient
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', { serverId: 'target', threadId: 'thread', workspacePath: '/owned', runtimeHandle: {} }]]),
    clientByTask: new Map([['task', client]]), threadByTask: new Map([['task', 'thread']]),
    taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (serverId: string, threadId: string) => `${serverId}\0${threadId}`,
    pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
    remoteSessions: { handleNotification: () => false },
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(runtime, client, {
    id: 101, method: 'approval/request', params: {
      threadId: 'thread', turnId: 'turn', approvalId: 'approval', appServerEpoch: 'epoch',
      action: { type: 'command', command: 'echo controlled' },
      ...(availableDecisions === undefined ? {} : { availableDecisions }),
    },
  }, 'target')
  return { runtime, client, pending: runtime.pendingQuestionByKey.get(`task\0${101}`)! }
}

const choices = [
  ['accept', 'Allow once'],
  ['accept_for_session', 'Always allow for this session'],
  ['decline', 'Decline'],
  ['cancel', 'Cancel'],
] as const

test.each(choices)('an approval restricted to %s exposes and submits its only legal choice', async (decision, label) => {
  const { runtime, client, pending } = await fixture([decision])
  expect(pending.renderPayload.questions).toMatchObject([{ options: [{ label }] }])
  expect((pending.renderPayload.questions as { options: unknown[] }[])[0].options).toHaveLength(1)
  expect(pending.approvalDecisions).toEqual({ [label]: decision })
  const response = { requestId: 101, answers: { approval: { answers: [label] } } }
  expect(await respondToTaskQuestion.call(runtime, 'task', response)).toMatchObject({ accepted: true })
  expect(client.respond).toHaveBeenCalledExactlyOnceWith(101, {
    threadId: 'thread', turnId: 'turn', approvalId: 'approval', appServerEpoch: 'epoch', decision,
  })
  await respondToTaskQuestion.call(runtime, 'task', response)
  expect(client.respond).toHaveBeenCalledOnce()
  await forwardAcceptedNotification.call(runtime, 'approval/resolved', {
    threadId: 'thread', turnId: 'turn', requestId: 101, approvalId: 'approval', appServerEpoch: 'epoch',
    reason: 'client_response', decision,
  }, 'target', client)
  expect(runtime.pendingQuestionByKey.size).toBe(0)
})

test.each([undefined, null])('legacy omitted/null decisions preserve Allow once and Decline (%s)', async decisions => {
  const { pending } = await fixture(decisions)
  expect(pending.approvalDecisions).toEqual({ 'Allow once': 'accept', Decline: 'decline' })
})

test('the legacy session-decision spelling keeps its existing wire mapping', async () => {
  const { pending } = await fixture(['acceptForSession', 'cancel'])
  expect(pending.approvalDecisions).toEqual({ 'Always allow for this session': 'accept_for_session', Cancel: 'cancel' })
})
