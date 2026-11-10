import '@/i18n'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ToolBlock, WorkbenchMessage } from '@/types/workbench'
import { ToolBlocksDisplay } from '@/components/chat/blocks/ToolBlocksDisplay'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardApprovalRequest, forwardServerRequest } from './interactions'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

for (const kind of ['question', 'approval'] as const) {
  test.each(['client_response', 'response_error', 'cancelled', 'client_cancelled'])(
    `${kind}: an original %s receipt closes viewer input without inventing its peer's answer`, async reason => {
      const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
      const client = { respond: vi.fn(), supportsExperimental: () => true }
      const runtime = {
        disposed: false, appServerDisconnectedClients: new WeakSet(),
        tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, workspacePath: '/owned' }]]),
        clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, threadId]]),
        taskByThread: new Map([['target\0thread', taskId]]),
        threadKey: (server: string, thread: string) => `${server}\0${thread}`,
        pendingQuestionByKey: new Map(), turnAttemptIds: new Map(),
        remoteSessions: { handleNotification: () => false }, forwardApprovalRequest,
      } as unknown as GatewayRuntimeCore
      const params = { threadId, turnId, appServerEpoch: 'epoch',
        ...(kind === 'question'
          ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Choose?', options: [] }] }
          : { approvalId: 'approval-101', action: { type: 'command', command: 'echo controlled' } }) }
      await forwardServerRequest.call(runtime, client as never,
        { id: requestId, method: `${kind}/request`, params }, 'target')
      const original = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
      expect(original.submittedResponse).toBeUndefined()
      const block = original.block as unknown as ToolBlock
      const messages = (value: ToolBlock) => [{ id: 'assistant', role: 'assistant', content: '',
        status: 'streaming', blocks: [value] }] as WorkbenchMessage[]
      expect(pendingRequestUserInputPayload(messages(block))).not.toBeNull()
      const submit = vi.fn()
      const view = render(<ToolBlocksDisplay blocks={[block]} isStreaming onRequestUserInputSubmit={submit} />)
      expect(screen.getByTestId('request-user-input-card')).toBeInTheDocument()

      await forwardAcceptedNotification.call(runtime, `${kind}/resolved`, {
        ...params, requestId, reason, ...(kind === 'approval' ? { decision: 'accept' } : {}),
      }, 'target', client as never)
      const terminal = vi.mocked(emitRuntimeEvent).mock.calls.at(-1)![1] as unknown as {
        payload: { data: { updates: Partial<ToolBlock> } }
      }
      const settled = { ...block, ...terminal.payload.data.updates }
      expect(settled.renderPayload).not.toHaveProperty('response')
      expect(runtime.pendingQuestionByKey.size).toBe(0)
      expect(pendingRequestUserInputPayload(messages(settled))).toBeNull()
      view.rerender(<ToolBlocksDisplay blocks={[settled]} isStreaming onRequestUserInputSubmit={submit} />)
      if (reason === 'client_response') {
        expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
        expect(screen.getByTestId('request-user-input-summary')).toBeInTheDocument()
      } else {
        expect(settled.status).toBe('error')
        if (kind === 'question' && reason === 'client_cancelled')
          expect(settled.toolOutput).toBe('问题请求已取消。')
        expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
      }
      expect(client.respond).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    })
}
