import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { captureTaskInteraction, readTaskInteractions, respondTaskInteraction } from '@/kcoder/gateway/runtime/taskInteractions'
import { respondToTaskQuestion } from '@/kcoder/gateway/runtime/interactions'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { GatewayClient } from '@/kcoder/gatewayRuntimeTypes'
import type { PendingGatewayQuestion } from '@/kcoder/gateway/runtime/contracts'
import { RequestUserInputCard } from './RequestUserInputCard'

vi.mock('@/kcoder/gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

const padded = '\t Keep original source \u00a0'
const question = {
  id: 'choice', header: 'Source', question: 'Which source?', isOther: false,
  options: [
    { label: 'Keep original source', description: 'First choice' },
    { label: padded, description: 'Distinct original choice' },
  ],
}

test('clicking a padded option sends its exact original label', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [question] }} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-1'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { choice: { answers: [padded] } },
  }))
})

test('the preselected default keeps the original option value', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ ...question, options: [question.options[1]] }] }} onSubmit={submit} />)
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { choice: { answers: [padded] } },
  }))
})

test('multiple choices differing only by surrounding whitespace remain independent', () => {
  const submit = vi.fn()
  render(<RequestUserInputCard payload={{ questions: [{ ...question, multiSelect: true }] }} onSubmit={submit} />)
  const first = screen.getByTestId('request-user-input-option-choice-0')
  const second = screen.getByTestId('request-user-input-option-choice-1')
  fireEvent.click(first)
  expect(second).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(second)
  expect(first).toHaveAttribute('aria-pressed', 'true')
  expect(second).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    answers: { choice: { answers: [question.options[0].label, padded] } },
  }))
})

test.each([false, true])('the original task controller receives the exact card selection (colliding labels=%s)', async collision => {
  const taskId = 'original-task', requestId = 2000001
  const frame = { serverId: 'process', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(async (_method, selector) => ({ ...selector, status: 'pending' })),
    respond: vi.fn(),
  } as unknown as GatewayClient
  const pending = {
    client, taskId, requestId, turnId: frame.turnId, questionId: 'question', block: { id: 'block' },
    renderPayload: { requestId, itemId: 'question', questions: [{ ...question, options: [
      { ...question.options[0], label: collision ? question.options[0].label : 'Another source' },
      question.options[1],
    ] }] },
  } as PendingGatewayQuestion
  const server = { id: 'target', transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const task = { taskId, serverId: server.id, threadId: frame.threadId, workspacePath: server.workspacePath,
    runtimeHandle: { memoryTaskSnapshot: { threadId: frame.threadId, turnId: frame.turnId,
      attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(), tasks: new Map([[taskId, task]]),
    clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, frame.threadId]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    pendingQuestionByKey: new Map([[`${taskId}\0${requestId}`, pending]]),
    serverForParams: async () => server, taskDescriptor: async () => ({ taskId, task, server }),
    assertCommandTarget: async () => undefined,
    respondToTaskQuestion: (...args: Parameters<GatewayRuntimeCore['respondToTaskQuestion']>) =>
      respondToTaskQuestion.call(runtime, ...args),
  } as unknown as GatewayRuntimeCore
  const address = { deviceId: server.id, taskId, threadId: frame.threadId, workspacePath: server.workspacePath }
  await captureTaskInteraction(runtime, client, taskId, frame, requestId)
  const item = (await readTaskInteractions(runtime, { address })).items[0]
  const outcome = vi.fn()
  render(<RequestUserInputCard payload={{ questions: item.presentation.questions }} onSubmit={response =>
    respondTaskInteraction(runtime, { address, response: { reference: item.reference, answers: response.answers } })
      .then(outcome, outcome)
  } />)
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-1'))
  await waitFor(() => expect(outcome).toHaveBeenCalledExactlyOnceWith({ reference: item.reference, state: 'response_pending' }))
  expect(client.respond).toHaveBeenCalledExactlyOnceWith(requestId, {
    threadId: frame.threadId, turnId: frame.turnId, questionId: 'question',
    answers: { choice: { answers: [padded] } },
  })
})
