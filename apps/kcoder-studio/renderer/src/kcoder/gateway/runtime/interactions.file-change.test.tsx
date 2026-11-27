import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
afterEach(cleanup)

async function fixture(action: Record<string, unknown>) {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const client = { respond: vi.fn(), supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { serverId: 'target', threadId, workspacePath: '/owned', runtimeHandle: {} }]]),
    taskByThread: new Map([['target\0thread', taskId]]),
    threadKey: (server: string, thread: string) => `${server}\0${thread}`,
    clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
    threadByTask: new Map([[taskId, threadId]]), turnAttemptIds: new Map(),
    forwardApprovalRequest,
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(runtime, client as never, {
    id: requestId, method: 'approval/request', params: {
      threadId, turnId, approvalId: 'approval-file', appServerEpoch: 'epoch', action,
    },
  }, 'target')
  return { runtime, client, taskId, requestId, pending: runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`) }
}

test('an app-server file-change approval displays its path and waits for the original card answer', async () => {
  // ApprovalAction::FileChange carries path, with no transcript itemId.
  const path = '/owned/中文 notes.md'
  const f = await fixture({ type: 'file_change', path })
  expect(f.client.respond).not.toHaveBeenCalled()
  expect(f.pending).toBeDefined()
  expect(f.pending!.renderPayload.approvalPresentation).toMatchObject({ kind: 'file_change', subject: path })
  render(<RequestUserInputCard payload={f.pending!.renderPayload}
    onSubmit={response => respondToTaskQuestion.call(f.runtime, f.taskId, response).then(result => result.accepted)} />)
  expect(screen.getByTestId('request-user-input-card')).toHaveTextContent(path)
  fireEvent.click(screen.getByTestId('request-user-input-option-approval-file-0'))
  await waitFor(() => expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, {
    approvalId: 'approval-file', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', decision: 'accept',
  }))
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(f.client.respond).toHaveBeenCalledTimes(1)
})

test.each([undefined, '   ', 42])('a file-change approval without a usable path (%s) stays fail closed', async path => {
  const f = await fixture({ type: 'file_change', path, itemId: 'unrelated-transcript-item' })
  expect(f.pending).toBeUndefined()
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, {
    approvalId: 'approval-file', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', decision: 'decline',
  })
})
