import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { isImplementationPlanRequestUserInput } from '@/components/chat/requestUserInputMessages'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

test.each(['implement', 'strategy'])('original conversation question %s retains every answer instead of confirming a synthetic plan', async id => {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const client = { respond: vi.fn(), supportsExperimental: (name: string) => name === 'interactionBindingV1' }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { serverId: 'target', threadId }]]),
    taskByThread: new Map([['target\0thread', taskId]]),
    threadKey: (serverId: string, thread: string) => `${serverId}\0${thread}`,
    clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
    threadByTask: new Map([[taskId, threadId]]),
    activeTurnByTask: new Map([[taskId, { turnId }]]), turnAttemptIds: new Map(),
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(runtime, client as never, {
    id: requestId, method: 'question/request', params: {
      threadId, turnId, questionId: 'original-question', questions: [
        { id, header: 'Strategy', prompt: 'How should work proceed?', allowsFreeform: false,
          options: [{ label: '执行此计划', description: '' }, { label: 'Review first', description: '' }] },
        { id: 'scope', header: 'Scope', prompt: 'Which scope?', allowsFreeform: true, options: [] },
      ],
    },
  }, 'target')
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  expect(isImplementationPlanRequestUserInput(pending.renderPayload)).toBe(false)
  const completed = vi.fn()
  render(<RequestUserInputCard payload={pending.renderPayload} onSubmit={response =>
    respondToTaskQuestion.call(runtime, taskId, response, pending).then(completed)
  } />)
  const draft = screen.getByTestId('request-user-input-custom-scope')
  fireEvent.change(draft, { target: { value: 'Keep the original task and selected module' } })
  fireEvent.click(screen.getByTestId(`request-user-input-option-${id}-0`))
  expect(client.respond).not.toHaveBeenCalled()
  expect(draft).toHaveValue('Keep the original task and selected module')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(completed).toHaveBeenCalledOnce())
  expect(client.respond).toHaveBeenCalledExactlyOnceWith(requestId, {
    threadId, turnId, questionId: 'original-question',
    answers: { [id]: { answers: ['执行此计划'] },
      scope: { answers: ['Keep the original task and selected module'] } },
  })
})

test('an ordinary single-item Native question still submits its selected option immediately', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ allowImplementationPlanShortcut: false,
    requestId: 102, itemId: 'single-question', questions: [{ id: 'choice', question: 'Which?',
      isOther: false, options: [{ label: 'Continue' }] }] }} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
  expect(submit).toHaveBeenCalledExactlyOnceWith({ requestId: 102, itemId: 'single-question',
    answers: { choice: { answers: ['Continue'] } } })
})
