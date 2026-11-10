import { expect, test, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

async function fixture() {
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const taskId = 'original-task', requestId = 101, approvalId = 'original-approval'
  const core = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    clientByTask: new Map([[taskId, client]]),
    tasks: new Map([[taskId, { serverId: 'target' }]]),
    threadByTask: new Map([[taskId, 'original-thread']]),
    turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  await forwardApprovalRequest.call(core, client as never, requestId, {
    approvalId, threadId: 'original-thread', turnId: 'original-turn',
    action: { type: 'command', command: 'echo controlled' },
    availableDecisions: ['accept', 'accept_for_session', 'decline'],
  }, taskId, 'original-turn')
  const pending = core.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  return { core, client, pending, approvalId, taskId, requestId }
}

for (const mixed of [false, true]) {
  test(`approval refuses ${mixed ? 'mixed original and foreign' : 'foreign-only'} answer items without consuming its card`, async () => {
    const f = await fixture()
    // A stale draft can carry the same transport ID and a valid approval label
    // under another card's item ID. It must never authorize this operation.
    const answers = {
      'stale-approval': { answers: ['Allow once'] },
      ...(mixed ? { [f.approvalId]: { answers: ['Decline'] } } : {}),
    }
    const result = await respondToTaskQuestion.call(f.core, f.taskId, {
      requestId: f.requestId, answers,
    })
    expect(result).toMatchObject({ accepted: false, code: 'interaction_answer_conflict' })
    expect(f.client.respond).not.toHaveBeenCalled()
    expect(f.pending.responsePending).toBeUndefined()
    expect(f.pending.submittedResponse).toBeUndefined()
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
    const corrected = await respondToTaskQuestion.call(f.core, f.taskId, {
      requestId: f.requestId, answers: { [f.approvalId]: { answers: ['Decline'] } },
    })
    expect(corrected).toMatchObject({ accepted: true })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, {
      threadId: 'original-thread', turnId: 'original-turn', approvalId: f.approvalId, decision: 'decline',
    })
  })
}

test.each([
  ['Allow once', 'accept'],
  ['Always allow for this session', 'accept_for_session'],
  ['Decline', 'decline'],
])('original approval answer %s preserves its decision and duplicate-send guard', async (label, decision) => {
  const f = await fixture()
  const response = { requestId: f.requestId, answers: { [f.approvalId]: { answers: [label] } } }
  expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({ accepted: true })
  expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({
    accepted: false, code: 'request_user_input_response_pending',
  })
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, {
    threadId: 'original-thread', turnId: 'original-turn', approvalId: f.approvalId, decision,
  })
})
