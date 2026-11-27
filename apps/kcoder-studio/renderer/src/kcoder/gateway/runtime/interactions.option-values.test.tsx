import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

test.each([
  { name: 'distinct display label', options: [{ label: '继续', value: 'continue' }], expected: ['continue'] },
  { name: 'exact wire whitespace', options: [{ label: 'Continue', value: ' continue ' }], expected: [' continue '] },
  { name: 'label-only legacy option', options: [{ label: 'Continue' }], expected: ['Continue'] },
  { name: 'value-only legacy option', options: [{ value: 'continue' }], expected: ['continue'] },
  { name: 'equal labels with distinct values', multiSelect: true,
    options: [{ label: 'Continue', value: 'first' }, { label: 'Continue', value: 'second' }], expected: ['first', 'second'] },
])('original task card submits option values: $name', async ({ options, expected, multiSelect }) => {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const client = { respond: vi.fn(), supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { serverId: 'target', threadId }]]),
    taskByThread: new Map([['target\0thread', taskId]]),
    threadKey: (serverId: string, thread: string) => `${serverId}\0${thread}`,
    clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
    threadByTask: new Map([[taskId, threadId]]), turnAttemptIds: new Map(),
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(runtime, client as never, {
    id: requestId, method: 'question/request', params: {
      threadId, turnId, questionId: 'original-question', questions: [
        { id: 'choice', header: 'Choice', prompt: 'Continue?', allowsFreeform: false, multiSelect, options },
      ],
    },
  }, 'target')
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  const completed = vi.fn()
  render(<RequestUserInputCard payload={pending.renderPayload} onSubmit={response =>
    respondToTaskQuestion.call(runtime, taskId, response, pending).then(completed)
  } />)
  for (let index = 0; index < options.length; index++)
    fireEvent.click(screen.getByTestId(`request-user-input-option-choice-${index}`))
  if (multiSelect) fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(completed).toHaveBeenCalledOnce())
  expect(client.respond).toHaveBeenCalledExactlyOnceWith(requestId, {
    threadId, turnId, questionId: 'original-question', answers: { choice: { answers: expected } },
  })
})
