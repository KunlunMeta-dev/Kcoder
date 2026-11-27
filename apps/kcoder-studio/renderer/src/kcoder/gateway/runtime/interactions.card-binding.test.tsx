import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
afterEach(cleanup)

for (const kind of ['question', 'approval'] as const) {
  test.each(['turnId', 'appServerEpoch'] as const)(
    `a restored ${kind} card cannot answer a reused request/item ID after %s changes`, async field => {
      const taskId = 'task', threadId = 'thread', requestId = 101
      const client = { respond: vi.fn(), supportsExperimental: () => true }
      const runtime = {
        disposed: false, appServerDisconnectedClients: new WeakSet(),
        tasks: new Map([[taskId, { serverId: 'target', threadId }]]),
        taskByThread: new Map([['target\0thread', taskId]]),
        threadKey: (server: string, thread: string) => `${server}\0${thread}`,
        clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
        threadByTask: new Map([[taskId, threadId]]), turnAttemptIds: new Map(),
        forwardApprovalRequest,
      } as unknown as GatewayRuntimeCore
      const capture = (replacement = false) => forwardServerRequest.call(runtime, client as never, {
        id: requestId, method: `${kind}/request`, params: {
          threadId, turnId: replacement && field === 'turnId' ? 'new-turn' : 'original-turn',
          appServerEpoch: replacement && field === 'appServerEpoch' ? 'new-epoch' : 'original-epoch',
          ...(kind === 'question'
            ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Which?', options: [] }] }
            : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }),
        },
      }, 'target')
      await capture()
      const old = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
      const completed = vi.fn()
      const show = (payload: typeof old.renderPayload) => render(<RequestUserInputCard
        payload={payload}
        onSubmit={response => respondToTaskQuestion.call(runtime, taskId, response).then(result => {
          completed(result)
          return result.accepted
        })}
      />)
      show(old.renderPayload)
      if (kind === 'question') fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
        target: { value: 'Keep the original draft' },
      })
      await capture(true)
      const current = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
      expect(current).not.toBe(old)
      fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
      await waitFor(() => expect(completed).toHaveBeenCalledWith(expect.objectContaining({
        accepted: false, code: 'interaction_binding_conflict',
      })))
      expect(client.respond).not.toHaveBeenCalled()
      expect(current.responsePending).toBeUndefined()
      expect(current.submittedResponse).toBeUndefined()
      await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
      if (kind === 'question') expect(screen.getByTestId('request-user-input-custom-choice'))
        .toHaveValue('Keep the original draft')

      cleanup()
      show(current.renderPayload)
      if (kind === 'question') fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
        target: { value: 'Answer the current question' },
      })
      fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
      await waitFor(() => expect(client.respond).toHaveBeenCalledOnce())
      expect(current.responsePending).toBe(true)
    }
  )
}
