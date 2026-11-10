import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ComposerStatusItem, ComposerStatusRegion } from './composer/ComposerStatusRegion'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'
import { requestAsyncQuestion, supportsAsyncQuestions } from '@/kcoder/gateway/runtime/asyncQuestions'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'

const localExecutor = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: localExecutor.request,
  subscribeLocalExecutorEvents: localExecutor.subscribe,
}))

const addressA = { taskId: 'kcoder:server-a:thread-a', deviceId: 'server-a', threadId: 'thread-a' }
const addressB = { taskId: 'kcoder:server-b:thread-b', deviceId: 'server-b', threadId: 'thread-b' }
const addressWithoutThread = { taskId: 'kcoder:server-a:creating', deviceId: 'server-a' }

function panelKey(address: { deviceId: string; taskId: string; threadId?: string | null }) {
  return JSON.stringify([address.deviceId, address.taskId, address.threadId ?? null])
}

function questionStatusButton(container: HTMLElement) {
  const button = container.querySelector('[data-status-item="questions"] button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('Question status trigger is missing')
  return button
}

function question(
  patch: Partial<AsyncQuestionRecord> = {},
  threadId = 'thread-a'
): AsyncQuestionRecord {
  return {
    questionId: 'question-a',
    requestId: 'request-a',
    threadId,
    sourceTurnId: 'turn-a',
    toolCallId: 'call-a',
    revision: 3,
    createdAtMs: 1,
    status: 'pending',
    questions: [
      {
        id: 'item-a',
        header: 'Decision',
        question: 'Which option should the task use?',
        multiSelect: false,
        options: [
          { id: 'option-a', label: 'Option A', description: 'First option' },
          { id: 'option-b', label: 'Option B', description: 'Second option' },
        ],
      },
    ],
    ...patch,
  } as AsyncQuestionRecord
}

function questionRecord(
  questionId: string,
  itemId: string,
  threadId = 'thread-a'
): AsyncQuestionRecord {
  return question({
    questionId,
    questions: [
      {
        id: itemId,
        header: 'Decision',
        question: `How should ${questionId} proceed?`,
        multiSelect: false,
        options: [
          { id: 'option-a', label: 'Option A', description: 'First option' },
          { id: 'option-b', label: 'Option B', description: 'Second option' },
        ],
      },
    ],
  }, threadId)
}

function installExecutor(
  list: (taskId: string) => AsyncQuestionRecord[] = () => [question()],
  supported: (taskId: string) => boolean = () => true
) {
  localExecutor.request.mockImplementation(
    async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.asyncQuestion.supports') {
        const taskId = String(params.taskId)
        return {
          taskId,
          threadId: taskId.endsWith('thread-b') ? 'thread-b' : 'thread-a',
          supported: supported(taskId),
        }
      }
      if (method === 'runtime.asyncQuestion.request') {
        const taskId = String(params.taskId)
        return {
          threadId: taskId.endsWith('thread-b') ? 'thread-b' : 'thread-a',
          questions: list(taskId),
        }
      }
      throw new Error(`Unexpected renderer command ${method}`)
    }
  )
}

describe('AsyncQuestionPanel', () => {
  beforeAll(async () => {
    await createInstance().use(initReactI18next).init({
      lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
    })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    localExecutor.subscribe.mockResolvedValue(vi.fn())
  })

  it.each((['list', 'answer', 'saved-answer retry'] as const).flatMap(operation =>
    (['threadId', 'workspacePath', 'mutatedWorkspaceAddress'] as const).map(binding => [operation, binding] as const)))(
    '%s preserves the original %s before dispatch when the task mapping changes',
    async (operation, binding) => {
      const user = userEvent.setup()
      const saved = operation === 'saved-answer retry'
      const original = question(saved ? {
        status: 'queued',
        answer: { submissionId: 'saved-submission', acceptedAtMs: 2,
          answers: { 'item-a': { selectedOptionIds: ['option-a'] } } },
      } : {})
      const task = { taskId: addressA.taskId, serverId: addressA.deviceId,
        threadId: addressA.threadId, workspacePath: '/question-owner' }
      const client = {
        supportsExperimental: () => true,
        request: vi.fn(async (method: string) => {
          // Reuse the same question ID on the replacement task. Receipt checks
          // happen after this RPC, which is already too late for an answer.
          const current = { ...original, threadId: task.threadId }
          return method === 'asyncQuestion/list'
            ? { threadId: task.threadId, questions: [current] }
            : { threadId: task.threadId, question: current, accepted: false, duplicate: false }
        }),
      }
      const runtime = {
        resolveTaskId: (id: string) => id,
        taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
        readyTaskClient: async () => client,
        assertCommandTarget: async () => undefined,
        tasks: new Map([[task.taskId, task]]),
        clientByTask: new Map([[task.taskId, client]]),
        appServerDisconnectedClients: new WeakSet(),
      } as unknown as GatewayRuntimeCore
      localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) =>
        command === 'runtime.asyncQuestion.supports'
          ? supportsAsyncQuestions.call(runtime, params)
          : requestAsyncQuestion.call(runtime, params))
      const panelAddress = { ...addressA, workspacePath: '/question-owner' }
      render(<AsyncQuestionPanel address={panelAddress} />)
      await user.click(await screen.findByTestId('async-question-toggle'))
      if (operation === 'answer')
        await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
      expect(client.request).toHaveBeenCalledTimes(1)
      task[binding === 'threadId' ? 'threadId' : 'workspacePath'] =
        binding === 'threadId' ? 'replacement-thread' : '/replacement-workspace'
      if (binding === 'mutatedWorkspaceAddress') panelAddress.workspacePath = task.workspacePath
      const callsBeforeRebind = localExecutor.request.mock.calls.length
      if (operation === 'list') {
        await user.click(screen.getByTestId('async-question-refresh'))
        if (binding !== 'mutatedWorkspaceAddress') await screen.findByTestId('async-question-retry')
      } else {
        await user.click(screen.getByTestId(saved
          ? 'async-question-continue-delivery-question-a'
          : 'request-user-input-submit-button'))
        if (binding !== 'mutatedWorkspaceAddress') await screen.findByTestId('async-question-submit-error')
      }
      if (binding === 'mutatedWorkspaceAddress') {
        // The click retains its rendered workspace. A subsequent React render
        // may legitimately open the new workspace, but cannot send this answer.
        const request = localExecutor.request.mock.calls.slice(callsBeforeRebind).find(
          ([command, params]) => command === 'runtime.asyncQuestion.request' &&
            params.method === (operation === 'list' ? 'asyncQuestion/list' : 'asyncQuestion/answer')
        )
        expect(request?.[1].workspacePath).toBe('/question-owner')
        expect(client.request.mock.calls.every(([method]) => method === 'asyncQuestion/list')).toBe(true)
        return
      }
      // The real Gateway runtime must reject the stale binding before any
      // list/answer reaches the replacement task, including reconciliation.
      expect(client.request).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('async-question-card-question-a'))
        .toHaveAttribute('data-status', original.status)
      if (operation === 'answer') {
        expect(screen.getByTestId('request-user-input-option-item-a-0')).toHaveClass('bg-surface')
        expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
      }
    }
  )

  it.each(['list', 'answer'] as const)(
    'workspace switches fence an old %s receipt even when task and question IDs are reused',
    async operation => {
      const user = userEvent.setup()
      installExecutor()
      const original = localExecutor.request.getMockImplementation()!
      let finish!: (value: unknown) => void
      let hold = false
      localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
        const request = params as { method?: string; workspacePath?: string }
        if (hold && request.workspacePath === '/original' &&
            request.method === `asyncQuestion/${operation}`)
          return new Promise(resolve => { finish = resolve })
        return original(command, params)
      })
      const view = render(<AsyncQuestionPanel address={{ ...addressA, workspacePath: '/original' }} />)
      await user.click(await screen.findByTestId('async-question-toggle'))
      await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'Original workspace draft')
      hold = true
      await user.click(screen.getByTestId(operation === 'list'
        ? 'async-question-refresh' : 'request-user-input-submit-button'))
      expect(finish).toBeTypeOf('function')
      view.rerender(<AsyncQuestionPanel address={{ ...addressA, workspacePath: '/replacement' }} />)
      await waitFor(() => expect(localExecutor.request).toHaveBeenCalledWith(
        'runtime.asyncQuestion.request', expect.objectContaining({
          workspacePath: '/replacement', method: 'asyncQuestion/list',
        })
      ))
      await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
        .toHaveAttribute('data-status', 'pending'))
      await act(async () => finish(operation === 'list'
        ? { threadId: addressA.threadId, questions: [question({ revision: 99, status: 'cancelled' })] }
        : { threadId: addressA.threadId, accepted: true, duplicate: false,
            question: question({ revision: 99, status: 'cancelled' }) }))
      expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute('data-status', 'pending')
      await user.click(screen.getByTestId('async-question-toggle'))
      expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('')
      expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
      expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    }
  )

  it('starts collapsed and keeps ordinary input focused while questions arrive', async () => {
    const user = userEvent.setup()
    installExecutor()
    render(
      <>
        <textarea aria-label="Ordinary composer" />
        <AsyncQuestionPanel address={addressA} />
      </>
    )
    const composer = screen.getByRole('textbox', { name: 'Ordinary composer' })
    await user.click(composer)
    await user.type(composer, 'Continue the task')
    const toggle = await screen.findByTestId('async-question-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
    const onEvent = localExecutor.subscribe.mock.calls[0][0]
    onEvent({
      event: 'async-question:changed',
      payload: {
        taskId: addressA.taskId,
        serverId: addressA.deviceId,
        threadId: addressA.threadId,
      },
    })
    await waitFor(() =>
      expect(
        localExecutor.request.mock.calls.filter(
          ([, params]) => (params as { method?: string }).method === 'asyncQuestion/list'
        )
      ).toHaveLength(2)
    )
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue('Continue the task')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('preserves draft, selection and scroll when a new record arrives while the Region item is hidden', async () => {
    const user = userEvent.setup()
    const first = question({
      questionId: 'question-first',
      questions: [
        {
          id: 'item-choice',
          header: 'Choice',
          question: 'Which option should be selected?',
          multiSelect: true,
          options: [
            { id: 'option-a', label: 'Option A', description: 'First option' },
            { id: 'option-b', label: 'Option B', description: 'Second option' },
          ],
        },
        {
          id: 'item-first',
          header: 'Answer',
          question: 'Add details',
          multiSelect: false,
          options: [],
        },
      ],
    })
    const second = questionRecord('question-second', 'item-second')
    let records = [first]
    let failNextList = false
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { threadId: addressA.threadId, supported: true }
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list') {
        if (failNextList) {
          failNextList = false
          throw new Error('refresh failed')
        }
        return { threadId: addressA.threadId, questions: records }
      }
      throw new Error(`Unexpected renderer command ${command}`)
    })
    const { container } = render(
      <ComposerStatusRegion ownerKey={panelKey(addressA)}>
        <textarea aria-label="Ordinary composer" />
        <AsyncQuestionPanel address={addressA} />
        <ComposerStatusItem id="other-status" title="Other status">
          <div data-testid="other-status-details">Other status details</div>
        </ComposerStatusItem>
      </ComposerStatusRegion>
    )

    await waitFor(() => expect(questionStatusButton(container)).toBeInTheDocument())
    await user.click(questionStatusButton(container))
    const firstCard = await screen.findByTestId('async-question-card-question-first')
    const option = within(firstCard).getByTestId('request-user-input-option-item-choice-0')
    await user.click(option)
    await user.type(
      within(firstCard).getByTestId('request-user-input-custom-item-first'),
      'Keep this answer draft'
    )

    const scrollContainer = screen.getByTestId('composer-status-content-questions')
    expect(scrollContainer.className).toContain('max-h-[min(32dvh,18rem)]')
    expect(scrollContainer.className).toContain('overflow-y-auto')
    const detailsContent = screen.getByTestId('async-question-content')
    expect(detailsContent.className).not.toMatch(/max-h|overflow-y-auto/)
    const formQuestions = within(firstCard).getByTestId('request-user-input-questions')
    expect(formQuestions.className).not.toContain('overflow-y-auto')
    const stickyActions = within(firstCard).getByTestId('request-user-input-actions')
    expect(stickyActions).toHaveClass('sticky', 'bottom-0', 'bg-background')
    expect(formQuestions).toHaveClass('pb-14')
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 420 },
      clientHeight: { configurable: true, value: 180 },
    })
    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight)
    scrollContainer.scrollTop = 96

    await user.click(screen.getByRole('button', { name: 'Other status' }))
    expect(scrollContainer).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Other status' }))

    records = [first, second]
    const onEvent = localExecutor.subscribe.mock.calls[0][0]
    onEvent({
      event: 'async-question:changed',
      payload: {
        taskId: addressA.taskId,
        serverId: addressA.deviceId,
        threadId: addressA.threadId,
      },
    })
    await waitFor(() => expect(questionStatusButton(container)).toHaveTextContent('3'))
    expect(questionStatusButton(container)).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('composer-status-content-questions')).toBe(scrollContainer)
    expect(scrollContainer.scrollTop).toBe(96)
    expect(localExecutor.request.mock.calls.filter(([, params]) =>
      (params as { method?: string }).method === 'asyncQuestion/answer'
    )).toHaveLength(0)

    await user.click(questionStatusButton(container))
    expect(await screen.findByTestId('async-question-card-question-second')).toBeVisible()
    expect(within(firstCard).getByTestId('request-user-input-custom-item-first')).toHaveValue(
      'Keep this answer draft'
    )
    expect(option).toHaveAttribute('aria-pressed', 'true')
    expect(scrollContainer.scrollTop).toBe(96)

    failNextList = true
    await user.click(screen.getByTestId('async-question-refresh'))
    expect(await screen.findByTestId('async-question-retry')).toBeVisible()
    expect(questionStatusButton(container)).toHaveTextContent(/refresh failed/i)
    await user.click(questionStatusButton(container))
    await user.click(questionStatusButton(container))
    expect(screen.getByTestId('async-question-retry')).toBeVisible()
    expect(within(firstCard).getByTestId('request-user-input-custom-item-first')).toHaveValue(
      'Keep this answer draft'
    )
    expect(scrollContainer.scrollTop).toBe(96)
  })

  it('appends a separate pending record without undoing the first answer or submitting it implicitly', async () => {
    const user = userEvent.setup()
    const first = questionRecord('question-first', 'item-first')
    const second = questionRecord('question-second', 'item-second')
    let records = [first]
    const answerCalls: Array<{ questionId: string; answers: Record<string, unknown> }> = []
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { threadId: addressA.threadId, supported: true }
      const request = params as { method?: string; params?: Record<string, unknown> }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
        return { threadId: addressA.threadId, questions: records }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/answer') {
        const rpcParams = request.params ?? {}
        const questionId = String(rpcParams.questionId)
        const previous = records.find(record => record.questionId === questionId)
        if (!previous) throw new Error(`Unknown question ${questionId}`)
        const answered = {
          ...previous,
          revision: previous.revision + 1,
          status: 'context_applied',
          answer: {
            acceptedAtMs: 10,
            submissionId: String(rpcParams.submissionId),
            answers: rpcParams.answers as NonNullable<AsyncQuestionRecord['answer']>['answers'],
          },
        } as AsyncQuestionRecord
        answerCalls.push({
          questionId,
          answers: rpcParams.answers as Record<string, unknown>,
        })
        records = records.map(record => record.questionId === questionId ? answered : record)
        return { accepted: true, duplicate: false, threadId: addressA.threadId, question: answered }
      }
      throw new Error(`Unexpected renderer command ${command}`)
    })
    const { container } = render(
      <ComposerStatusRegion ownerKey={panelKey(addressA)}>
        <AsyncQuestionPanel address={addressA} />
      </ComposerStatusRegion>
    )

    await waitFor(() => expect(questionStatusButton(container)).toBeInTheDocument())
    await user.click(questionStatusButton(container))
    const firstCard = await screen.findByTestId('async-question-card-question-first')
    await user.click(within(firstCard).getByTestId('request-user-input-option-item-first-0'))
    await user.click(within(firstCard).getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(firstCard).toHaveAttribute('data-status', 'context_applied'))
    expect(within(firstCard).getByTestId('async-question-authoritative-answer-question-first'))
      .toHaveTextContent('Option A')
    expect(answerCalls).toHaveLength(1)

    records = [first, second]
    const onEvent = localExecutor.subscribe.mock.calls[0][0]
    onEvent({
      event: 'async-question:changed',
      payload: {
        taskId: addressA.taskId,
        serverId: addressA.deviceId,
        threadId: addressA.threadId,
      },
    })
    const secondCard = await screen.findByTestId('async-question-card-question-second')
    await waitFor(() => expect(questionStatusButton(container)).toHaveTextContent('1'))
    expect(firstCard).toHaveAttribute('data-status', 'context_applied')
    expect(within(firstCard).getByTestId('async-question-authoritative-answer-question-first'))
      .toHaveTextContent('Option A')
    expect(answerCalls).toHaveLength(1)

    await user.type(
      within(secondCard).getByTestId('request-user-input-custom-item-second'),
      'Answer for the new record'
    )
    expect(answerCalls).toHaveLength(1)
    await user.click(within(secondCard).getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(answerCalls).toHaveLength(2))
    expect(answerCalls[1].questionId).toBe('question-second')
    expect(answerCalls[1].answers['item-second']).toMatchObject({
      selectedOptionIds: [],
      text: 'Answer for the new record',
    })
    expect(await screen.findByTestId('async-question-authoritative-answer-question-second'))
      .toHaveTextContent('Answer for the new record')
    expect(within(firstCard).getByTestId('async-question-authoritative-answer-question-first'))
      .toHaveTextContent('Option A')
  })

  it('keeps saved delivery visible beside a primary status item in expanded and compact Region rows', async () => {
    const user = userEvent.setup()
    installExecutor(() => [question({
      status: 'answer_saved',
      revision: 4,
      answer: {
        submissionId: 'saved-submission',
        answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
        acceptedAtMs: 5,
      },
    })])
    const { container } = render(
      <ComposerStatusRegion ownerKey={panelKey(addressA)}>
        <ComposerStatusItem id="goal" title="Goal">
          <p>Goal details</p>
        </ComposerStatusItem>
        <AsyncQuestionPanel address={addressA} />
      </ComposerStatusRegion>
    )

    await waitFor(() => expect(questionStatusButton(container)).toBeInTheDocument())
    const questionTrigger = questionStatusButton(container)
    expect(questionTrigger).toHaveTextContent('1 awaiting delivery')
    expect(questionTrigger.querySelector('.tabular-nums')).toBeNull()
    expect(questionTrigger).not.toHaveClass('text-warning')

    await user.click(screen.getByRole('button', { name: 'Collapse status row' }))
    const compactSummary = screen.getByRole('button', { name: /Show status details/ })
    expect(compactSummary).toHaveTextContent('Questions')
    expect(compactSummary).toHaveTextContent('1 awaiting delivery')
    expect(compactSummary).not.toHaveTextContent('Questions 0')
    expect(compactSummary).not.toHaveTextContent('attentionCount')
  })

  it('keeps the initial shell hidden until the supported owner list settles empty', async () => {
    let finishList!: (value: unknown) => void
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return Promise.resolve({
          taskId: addressA.taskId,
          threadId: addressA.threadId,
          supported: true,
        })
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
        return new Promise(resolve => { finishList = resolve })
      throw new Error('Unexpected runtime method')
    })
    render(<AsyncQuestionPanel address={addressA} />)

    await waitFor(() => expect(finishList).toBeTypeOf('function'))
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()

    await act(async () => finishList({ threadId: addressA.threadId, questions: [] }))
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
  })

  it('does no question RPC while creation is pending, then hides a canonical empty list', async () => {
    localExecutor.request.mockImplementation(async (command: string) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { supported: true, threadId: addressA.threadId }
      if (command === 'runtime.asyncQuestion.request')
        return { threadId: addressA.threadId, questions: [] }
      throw new Error(`Unexpected runtime command ${command}`)
    })
    const view = render(
      <ComposerStatusRegion ownerKey={panelKey(addressWithoutThread)}>
        <AsyncQuestionPanel address={addressWithoutThread} pendingCreation />
      </ComposerStatusRegion>
    )

    expect(localExecutor.request).not.toHaveBeenCalled()
    expect(localExecutor.subscribe).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-status-item="questions"]')).toBeNull()
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()

    view.rerender(
      <ComposerStatusRegion ownerKey={panelKey(addressA)}>
        <AsyncQuestionPanel address={addressA} pendingCreation={false} />
      </ComposerStatusRegion>
    )
    await waitFor(() => expect(localExecutor.request).toHaveBeenCalledWith(
      'runtime.asyncQuestion.request',
      { taskId: addressA.taskId, deviceId: addressA.deviceId, method: 'asyncQuestion/list', params: { threadId: addressA.threadId, includeTerminal: true } }
    ))
    expect(view.container.querySelector('[data-status-item="questions"]')).toBeNull()
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
  })

  it('keeps unsupported tasks without a thread ID hidden and reports unresolved supported ownership neutrally', async () => {
    const ownerWithoutThread = {
      taskId: 'kcoder:server-a:owner-unknown',
      deviceId: 'server-a',
    }
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command !== 'runtime.asyncQuestion.supports') throw new Error('List must not be requested')
      if (params.taskId === ownerWithoutThread.taskId) return { supported: true }
      return { supported: false }
    })
    const view = render(
      <ComposerStatusRegion ownerKey={panelKey(addressWithoutThread)}>
        <AsyncQuestionPanel address={addressWithoutThread} />
      </ComposerStatusRegion>
    )
    await waitFor(() => expect(localExecutor.request).toHaveBeenCalledWith(
      'runtime.asyncQuestion.supports', { taskId: addressWithoutThread.taskId, deviceId: addressWithoutThread.deviceId }
    ))
    expect(view.container.querySelector('[data-status-item="questions"]')).toBeNull()
    expect(localExecutor.request.mock.calls.some(([, params]) =>
      (params as { method?: string }).method === 'asyncQuestion/list'
    )).toBe(false)

    view.rerender(
      <ComposerStatusRegion ownerKey={panelKey(ownerWithoutThread)}>
        <AsyncQuestionPanel address={ownerWithoutThread} />
      </ComposerStatusRegion>
    )
    const trigger = await waitFor(() => questionStatusButton(view.container))
    expect(trigger).toHaveTextContent('Question status')
    expect(trigger).toHaveTextContent('Could not read question status')
    expect(trigger).not.toHaveTextContent('Questions')
    expect(trigger).not.toHaveTextContent('Refresh failed')
    expect(localExecutor.request.mock.calls.some(([, params]) =>
      (params as { method?: string }).method === 'asyncQuestion/list'
    )).toBe(false)
  })

  it('shows a neutral support error and hides again after retry confirms an empty list', async () => {
    const user = userEvent.setup()
    let supportCalls = 0
    localExecutor.request.mockImplementation(async (command: string) => {
      if (command === 'runtime.asyncQuestion.supports') {
        supportCalls += 1
        if (supportCalls === 1) throw new Error('capability read failed')
        return { supported: true, threadId: addressA.threadId }
      }
      if (command === 'runtime.asyncQuestion.request')
        return { threadId: addressA.threadId, questions: [] }
      throw new Error(`Unexpected runtime command ${command}`)
    })
    const { container } = render(
      <ComposerStatusRegion ownerKey={panelKey(addressA)}>
        <AsyncQuestionPanel address={addressA} />
      </ComposerStatusRegion>
    )

    const trigger = await waitFor(() => questionStatusButton(container))
    expect(trigger).toHaveTextContent('Question status')
    expect(trigger).toHaveTextContent('Could not read question status')
    expect(trigger).not.toHaveTextContent('Questions')
    expect(trigger).not.toHaveTextContent('Refresh failed')
    await user.click(trigger)
    expect(await screen.findByText(/Could not check whether this task supports asynchronous questions/))
      .toBeVisible()
    await user.click(screen.getByTestId('async-question-retry'))

    await waitFor(() => expect(container.querySelector('[data-status-item="questions"]')).toBeNull())
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
    expect(supportCalls).toBe(2)
    expect(localExecutor.request.mock.calls.filter(([, params]) =>
      (params as { method?: string }).method === 'asyncQuestion/list'
    )).toHaveLength(1)
  })

  it('ignores a late old-owner list failure and labels the current initial list failure neutrally', async () => {
    const user = userEvent.setup()
    let finishOldRefresh!: (reason: Error) => void
    let oldListCalls = 0
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      const taskId = String(params.taskId)
      if (command === 'runtime.asyncQuestion.supports') {
        return Promise.resolve(taskId === addressA.taskId
          ? { threadId: addressA.threadId, supported: true }
          : { threadId: addressB.threadId, supported: true })
      }
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list') {
        if (taskId === addressA.taskId) {
          oldListCalls += 1
          if (oldListCalls === 1)
            return Promise.resolve({ threadId: addressA.threadId, questions: [question()] })
          return new Promise((_resolve, reject) => { finishOldRefresh = reject })
        }
        return Promise.reject(new Error('initial list read failed'))
      }
      throw new Error(`Unexpected runtime command ${command}`)
    })
    const renderPanel = (address: typeof addressA | typeof addressB, pendingCreation = false) => (
      <ComposerStatusRegion ownerKey={panelKey(address)}>
        <AsyncQuestionPanel address={address} pendingCreation={pendingCreation} />
      </ComposerStatusRegion>
    )
    const view = render(renderPanel(addressA))

    const trigger = await waitFor(() => questionStatusButton(view.container))
    await user.click(trigger)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(finishOldRefresh).toBeTypeOf('function'))

    view.rerender(renderPanel(addressB, true))
    expect(view.container.querySelector('[data-status-item="questions"]')).toBeNull()
    await act(async () => finishOldRefresh(new Error('old owner refresh failed')))
    expect(view.container.querySelector('[data-status-item="questions"]')).toBeNull()
    expect(screen.queryByTestId('async-question-card-question-a')).not.toBeInTheDocument()

    view.rerender(renderPanel(addressB, false))
    const currentTrigger = await waitFor(() => questionStatusButton(view.container))
    expect(currentTrigger).toHaveTextContent('Question status')
    expect(currentTrigger).toHaveTextContent('Could not read question status')
    expect(currentTrigger).not.toHaveTextContent('Questions')
    expect(currentTrigger).not.toHaveTextContent('Refresh failed')
    expect(screen.queryByTestId('async-question-card-question-a')).not.toBeInTheDocument()
    await user.click(currentTrigger)
    expect(await screen.findByText(/Could not read this task’s question list/)).toBeVisible()
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  })

  it('shows the first real question only after the supported owner list returns it', async () => {
    let finishList!: (value: unknown) => void
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return Promise.resolve({
          taskId: addressA.taskId,
          threadId: addressA.threadId,
          supported: true,
        })
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
        return new Promise(resolve => { finishList = resolve })
      throw new Error('Unexpected runtime method')
    })
    render(<AsyncQuestionPanel address={addressA} />)

    await waitFor(() => expect(finishList).toBeTypeOf('function'))
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
    await act(async () => finishList({ threadId: addressA.threadId, questions: [question()] }))

    expect(await screen.findByTestId('async-question-card-question-a')).toBeInTheDocument()
  })

  it('keeps the displayed question and answer draft while a refresh is pending', async () => {
    const user = userEvent.setup()
    let listCalls = 0
    let finishRefresh!: (value: unknown) => void
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list') {
        listCalls += 1
        if (listCalls === 2) return new Promise(resolve => { finishRefresh = resolve })
      }
      return original(command, params)
    })
    render(<AsyncQuestionPanel address={addressA} />)

    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    const draft = screen.getByTestId('request-user-input-custom-item-a')
    await user.type(draft, 'Keep this draft during refresh')
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'))

    expect(screen.getByTestId('async-question-card-question-a')).toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue(
      'Keep this draft during refresh'
    )

    await act(async () => finishRefresh({ threadId: addressA.threadId, questions: [question()] }))
  })

  it('hides the previous owner immediately and ignores its delayed refresh after an owner switch', async () => {
    const user = userEvent.setup()
    let finishOldRefresh!: (value: unknown) => void
    let finishNewList!: (value: unknown) => void
    let oldListCalls = 0
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      const taskId = String(params.taskId)
      if (command === 'runtime.asyncQuestion.supports') {
        const isNewOwner = taskId === addressB.taskId
        return Promise.resolve({
          taskId,
          threadId: isNewOwner ? addressB.threadId : addressA.threadId,
          supported: true,
        })
      }
      const request = params as { method?: string }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list') {
        if (taskId === addressA.taskId) {
          oldListCalls += 1
          if (oldListCalls === 1)
            return Promise.resolve({ threadId: addressA.threadId, questions: [question()] })
          return new Promise(resolve => { finishOldRefresh = resolve })
        }
        return new Promise(resolve => { finishNewList = resolve })
      }
      throw new Error('Unexpected runtime method')
    })
    const view = render(<AsyncQuestionPanel key={panelKey(addressA)} address={addressA} />)

    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'Old owner draft')
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(finishOldRefresh).toBeTypeOf('function'))

    view.rerender(<AsyncQuestionPanel key={panelKey(addressB)} address={addressB} />)
    await waitFor(() => expect(finishNewList).toBeTypeOf('function'))
    expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('async-question-card-question-a')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Old owner draft')).not.toBeInTheDocument()

    await act(async () =>
      finishNewList({
        threadId: addressB.threadId,
        questions: [question({ questionId: 'question-b' }, addressB.threadId)],
      })
    )
    expect(await screen.findByTestId('async-question-card-question-b')).toBeInTheDocument()

    await act(async () =>
      finishOldRefresh({
        threadId: addressA.threadId,
        questions: [question({ questionId: 'question-old' })],
      })
    )
    expect(screen.getByTestId('async-question-panel')).toHaveAttribute(
      'data-task-id',
      addressB.taskId
    )
    expect(screen.getByTestId('async-question-card-question-b')).toBeInTheDocument()
    expect(screen.queryByTestId('async-question-card-question-old')).not.toBeInTheDocument()
  })

  it('shows initial list errors without requiring expansion', async () => {
    installExecutor()
    localExecutor.request.mockImplementation(async (method: string) => {
      if (method === 'runtime.asyncQuestion.supports')
        return { threadId: addressA.threadId, supported: true }
      throw new Error('network unavailable')
    })
    render(<AsyncQuestionPanel address={addressA} />)
    expect(await screen.findByTestId('async-question-summary')).toBeVisible()
    expect(screen.getByTestId('async-question-summary')).toHaveTextContent('Could not read question status')
    expect(screen.getByTestId('async-question-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
  })

  it('recovers the current task after a capability read failure without sending an answer', async () => {
    const user = userEvent.setup()
    installExecutor()
    localExecutor.request.mockRejectedValueOnce(new Error('Initial capability read failed'))
    render(<AsyncQuestionPanel address={addressA} />)
    expect(await screen.findByTestId('async-question-summary')).toHaveTextContent('Could not read question status')
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
      .toHaveAttribute('data-status', 'pending'))
    expect(screen.getByTestId('async-question-summary')).not.toHaveTextContent('Could not read question status')
    expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    expect(localExecutor.request.mock.calls.some(([, params]) =>
      (params as { method?: string }).method === 'asyncQuestion/answer')).toBe(false)
  })

  it.each(['different task', 'same task revisited', 'same task revisited after rejection'])(
    'ignores a delayed capability retry for a %s',
    async scenario => {
      const user = userEvent.setup()
      installExecutor(taskId => [question({}, taskId === addressB.taskId ? 'thread-b' : 'thread-a')])
      const original = localExecutor.request.getMockImplementation()!
      let attempt = 0
      let finishRetry!: (value: unknown) => void
      let rejectRetry!: (reason: Error) => void
      localExecutor.request.mockImplementation((method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.asyncQuestion.supports' && params.taskId === addressA.taskId) {
          attempt += 1
          if (attempt === 1) return Promise.reject(new Error('Initial capability read failed'))
          if (attempt === 2) return new Promise((resolve, reject) => {
            finishRetry = resolve
            rejectRetry = reject
          })
        }
        return original(method, params)
      })
      const view = render(<AsyncQuestionPanel address={addressA} />)
      expect(await screen.findByTestId('async-question-summary')).toHaveTextContent('Could not read question status')
      await user.click(screen.getByTestId('async-question-refresh'))
      expect(finishRetry).toBeTypeOf('function')
      view.rerender(<AsyncQuestionPanel address={addressB} />)
      await waitFor(() => expect(screen.getByTestId('async-question-panel'))
        .toHaveAttribute('data-task-id', addressB.taskId))
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      const finalAddress = scenario === 'different task' ? addressB : addressA
      if (finalAddress === addressA) {
        view.rerender(<AsyncQuestionPanel address={addressA} />)
        await waitFor(() => expect(screen.getByTestId('async-question-panel'))
          .toHaveAttribute('data-task-id', addressA.taskId))
        await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      }
      await act(async () => {
        if (scenario.endsWith('after rejection')) rejectRetry(new Error('Old transport failed'))
        else finishRetry({ threadId: addressA.threadId, supported: false })
      })
      expect(screen.getByTestId('async-question-panel'))
        .toHaveAttribute('data-task-id', finalAddress.taskId)
      expect(screen.getByTestId('async-question-summary')).not.toHaveTextContent('Could not read question status')
      localExecutor.request.mockClear()
      await user.click(screen.getByTestId('async-question-refresh'))
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      expect(localExecutor.request).toHaveBeenCalledWith('runtime.asyncQuestion.request', {
        deviceId: finalAddress.deviceId,
        taskId: finalAddress.taskId, method: 'asyncQuestion/list', params: { threadId: finalAddress.threadId, includeTerminal: true },
      })
      expect(localExecutor.request.mock.calls.every(([method]) => method === 'runtime.asyncQuestion.request')).toBe(true)
    }
  )

  it('shows saved answers awaiting delivery in the collapsed summary', async () => {
    installExecutor(() => [
      question({
        status: 'queued',
        answer: {
          submissionId: 'saved',
          answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
          acceptedAtMs: 5,
        },
      }),
    ])
    render(<AsyncQuestionPanel address={addressA} />)
    expect(await screen.findByTestId('async-question-summary')).toBeVisible()
    expect(screen.getByTestId('async-question-summary')).toHaveTextContent(/delivery|投递/)
    expect(screen.getByTestId('async-question-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('can collapse while answer submission is pending without cancelling or duplicating it', async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    localExecutor.request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (params.method === 'asyncQuestion/answer')
        return new Promise(resolve => {
          finish = resolve
        })
      return original(method, params)
    })
    render(<AsyncQuestionPanel address={addressA} />)
    const toggle = await screen.findByTestId('async-question-toggle')
    await user.click(toggle)
    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(screen.getByTestId('request-user-input-ignore-button')).toBeEnabled()
    await user.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const sent = localExecutor.request.mock.calls.find(([, params]) =>
      params.method === 'asyncQuestion/answer')![1].params
    finish({
      threadId: addressA.threadId,
      accepted: true,
      duplicate: false,
      question: question({ status: 'answer_saved', revision: 4, answer: {
        submissionId: sent.submissionId, answers: sent.answers, acceptedAtMs: 2,
      } }),
    })
    await waitFor(() =>
      expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
        'data-status',
        'answer_saved'
      )
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      localExecutor.request.mock.calls.filter(
        ([, params]) => (params as { method?: string }).method === 'asyncQuestion/answer'
      )
    ).toHaveLength(1)
  })

  it('lists existing and terminal questions after capability support and refreshes on a matching cross-device change', async () => {
    let revision = 3
    installExecutor(() => [
      question({
        revision,
        status: revision === 3 ? 'pending' : 'queued',
        ...(revision === 3 ? {} : { answer: {
          submissionId: 'from-another-device',
          answers: { 'item-a': { selectedOptionIds: ['option-b'] } },
          acceptedAtMs: 4,
        } }),
      }),
      question({ questionId: 'terminal-a', status: 'delivery_failed', revision: 9, answer: {
        submissionId: 'failed-delivery', acceptedAtMs: 4,
        answers: { 'item-a': { selectedOptionIds: ['option-b'] } },
      } }),
    ])
    render(<AsyncQuestionPanel address={addressA} />)

    expect(await screen.findByTestId('async-question-card-question-a')).toHaveAttribute(
      'data-status',
      'pending'
    )
    expect(screen.getByTestId('async-question-card-terminal-a')).toHaveAttribute(
      'data-status',
      'delivery_failed'
    )
    expect(localExecutor.request).toHaveBeenCalledWith('runtime.asyncQuestion.supports', {
      deviceId: addressA.deviceId,
      taskId: addressA.taskId,
    })
    expect(localExecutor.request).toHaveBeenCalledWith('runtime.asyncQuestion.request', {
      deviceId: addressA.deviceId,
      taskId: addressA.taskId,
      method: 'asyncQuestion/list',
      params: { threadId: addressA.threadId, includeTerminal: true },
    })

    revision = 4
    const onEvent = localExecutor.subscribe.mock.calls[0][0]
    onEvent({
      event: 'async-question:changed',
      payload: {
        taskId: addressA.taskId,
        serverId: addressA.deviceId,
        threadId: addressA.threadId,
        questionId: 'question-a',
        revision,
      },
    })
    await waitFor(() =>
      expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
        'data-status',
        'queued'
      )
    )
  })

  it('submits option IDs without auto-answering and retains the draft and submission identity after a failed RPC', async () => {
    const user = userEvent.setup()
    let answerAttempts = 0
    localExecutor.request.mockImplementation(
      async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { taskId: addressA.taskId, threadId: addressA.threadId, supported: true }
        const request = params as { method?: string; params?: Record<string, unknown> }
        if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [question()] }
        if (
          command === 'runtime.asyncQuestion.request' &&
          request.method === 'asyncQuestion/answer'
        ) {
          answerAttempts += 1
          if (answerAttempts === 1) throw new Error('connection lost')
          return {
            threadId: addressA.threadId,
            question: question({ status: 'answer_saved', revision: 4, answer: {
              submissionId: String(request.params?.submissionId),
              answers: request.params?.answers as NonNullable<AsyncQuestionRecord['answer']>['answers'],
              acceptedAtMs: 2,
            } }),
            accepted: true,
            duplicate: false,
          }
        }
        throw new Error('Unexpected runtime method')
      }
    )
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))

    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    expect(answerAttempts).toBe(0)
    const option = screen.getByTestId('request-user-input-option-item-a-0')
    expect(option).not.toHaveAttribute('aria-pressed')
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-option-item-a-0')).toHaveClass('bg-surface')

    await user.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() =>
      expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
        'data-status',
        'answer_saved'
      )
    )
    const answerCalls = localExecutor.request.mock.calls
      .map(([command, params]) => [command, params as Record<string, unknown>] as const)
      .filter(
        ([command, params]) =>
          command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/answer'
      )
      .map(([, params]) => params.params as Record<string, unknown>)
    expect(answerCalls).toHaveLength(2)
    expect(answerCalls[0]).toMatchObject({
      questionId: 'question-a',
      expectedRevision: 3,
      answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
    })
    expect(answerCalls[1].submissionId).toBe(answerCalls[0].submissionId)
  })

  for (const failureAfterRefresh of [false, true]) {
    it.each([
      'queued',
      'context_applied',
      'delivery_unknown',
      'delivery_failed',
      'cancelled',
      'stale',
    ] as const)(
      `replaces an old unconfirmed-answer warning with authoritative %s (failure after refresh=${failureAfterRefresh})`,
      async status => {
        const user = userEvent.setup()
        let current = question()
        let rejectAnswer!: (error: Error) => void
        localExecutor.request.mockImplementation(
          async (command: string, params: Record<string, unknown>) => {
            if (command === 'runtime.asyncQuestion.supports')
              return { threadId: addressA.threadId, supported: true }
            if (params.method === 'asyncQuestion/list')
              return { threadId: addressA.threadId, questions: [current] }
            if (params.method === 'asyncQuestion/answer')
              return new Promise((_resolve, reject) => {
                rejectAnswer = reject
              })
            throw new Error('Unexpected runtime method')
          }
        )
        render(<AsyncQuestionPanel address={addressA} />)
        await user.click(await screen.findByTestId('async-question-toggle'))
        await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
        await user.click(screen.getByTestId('request-user-input-submit-button'))
        expect(rejectAnswer).toBeTypeOf('function')
        current = question({
          status,
          revision: 4,
          ...(status === 'delivery_unknown' || status === 'delivery_failed'
            ? { deliveryError: 'Authoritative delivery needs review' }
            : {}),
          ...(status === 'cancelled' || status === 'stale'
            ? {}
            : {
                answer: {
                  submissionId: 'authoritative-submission',
                  acceptedAtMs: 2,
                  answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
                },
              }),
        })
        if (failureAfterRefresh) {
          await act(async () =>
            localExecutor.subscribe.mock.calls[0][0]({
              event: 'async-question:changed',
              payload: {
                taskId: addressA.taskId,
                serverId: addressA.deviceId,
                threadId: addressA.threadId,
              },
            })
          )
          await waitFor(() =>
            expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
              'data-status',
              status
            )
          )
        }
        await act(async () => rejectAnswer(new Error('answer receipt lost')))
        await waitFor(() =>
          expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
            'data-status',
            status
          )
        )
        expect(screen.getByTestId('async-question-panel')).not.toHaveTextContent(
          chat.async_questions.submitErrorShort
        )
        expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
        if (status === 'delivery_unknown' || status === 'delivery_failed')
          expect(screen.getByText('Authoritative delivery needs review')).toBeVisible()
        expect(
          localExecutor.request.mock.calls.filter(
            ([, params]) => params.method === 'asyncQuestion/answer'
          )
        ).toHaveLength(1)
      }
    )
  }

  it('does not let a late older failure erase a newer saved-answer retry warning', async () => {
    const user = userEvent.setup()
    let current = question()
    let rejectOriginal!: (error: Error) => void
    let attempts = 0
    localExecutor.request.mockImplementation(
      async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { threadId: addressA.threadId, supported: true }
        if (params.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [current] }
        if (params.method === 'asyncQuestion/answer') {
          if (++attempts === 1)
            return new Promise((_resolve, reject) => {
              rejectOriginal = reject
            })
          throw new Error('newer delivery receipt lost')
        }
        throw new Error('Unexpected runtime method')
      }
    )
    render(<AsyncQuestionPanel address={addressA} />)
    await user.click(await screen.findByTestId('async-question-toggle'))
    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    current = question({
      status: 'queued',
      revision: 4,
      answer: {
        submissionId: 'saved-submission',
        acceptedAtMs: 2,
        answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
      },
    })
    await act(async () =>
      localExecutor.subscribe.mock.calls[0][0]({
        event: 'async-question:changed',
        payload: {
          taskId: addressA.taskId,
          serverId: addressA.deviceId,
          threadId: addressA.threadId,
        },
      })
    )
    await user.click(await screen.findByTestId('async-question-continue-delivery-question-a'))
    expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
    await act(async () => rejectOriginal(new Error('older answer receipt lost')))
    expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('async-question-summary')).toHaveTextContent(
      chat.async_questions.submitErrorShort
    )
    expect(attempts).toBe(2)
  })

  it('retains an unconfirmed delivery warning when a saved-answer retry has no newer receipt', async () => {
    const user = userEvent.setup()
    const saved = question({
      status: 'queued',
      revision: 4,
      answer: {
        submissionId: 'saved-submission',
        acceptedAtMs: 2,
        answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
      },
    })
    installExecutor(() => [saved])
    const read = localExecutor.request.getMockImplementation()!
    localExecutor.request.mockImplementation(async (command, params) => {
      if (params.method === 'asyncQuestion/answer') throw new Error('delivery receipt lost')
      return read(command, params)
    })
    render(<AsyncQuestionPanel address={addressA} />)
    await user.click(await screen.findByTestId('async-question-toggle'))
    await user.click(screen.getByTestId('async-question-continue-delivery-question-a'))
    expect(await screen.findByTestId('async-question-submit-error')).toBeInTheDocument()
    expect(screen.getByTestId('async-question-summary')).toHaveTextContent(
      chat.async_questions.submitErrorShort
    )
  })

  it('continues a queued saved answer with its original submission identity and payload', async () => {
    const user = userEvent.setup()
    const saved = question({
      status: 'queued',
      revision: 4,
      answer: {
        submissionId: 'saved-submission-a',
        answers: { 'item-a': { selectedOptionIds: ['option-b'], text: 'preserve this' } },
        acceptedAtMs: 5,
      },
    })
    installExecutor(() => [saved])
    localExecutor.request.mockImplementation(
      async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { taskId: addressA.taskId, threadId: addressA.threadId, supported: true }
        const request = params as { method?: string; params?: Record<string, unknown> }
        if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [saved] }
        if (
          command === 'runtime.asyncQuestion.request' &&
          request.method === 'asyncQuestion/answer'
        )
          return { threadId: addressA.threadId, question: saved, accepted: true, duplicate: true }
        throw new Error('Unexpected runtime method')
      }
    )
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))

    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('async-question-continue-delivery-question-a'))
    await waitFor(() =>
      expect(localExecutor.request).toHaveBeenCalledWith(
        'runtime.asyncQuestion.request',
        expect.objectContaining({
          taskId: addressA.taskId,
          method: 'asyncQuestion/answer',
          params: {
            threadId: addressA.threadId,
            questionId: 'question-a',
            submissionId: 'saved-submission-a',
            expectedRevision: 4,
            answers: { 'item-a': { selectedOptionIds: ['option-b'], text: 'preserve this' } },
          },
        })
      )
    )
  })

  it('only refreshes delivery_unknown answers and never retries them', async () => {
    const user = userEvent.setup()
    const unknown = question({
      status: 'delivery_unknown',
      revision: 4,
      answer: {
        submissionId: 'unknown-submission-a',
        answers: { 'item-a': { selectedOptionIds: ['option-b'] } },
        acceptedAtMs: 5,
      },
    })
    installExecutor(() => [unknown])
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))

    expect(
      screen.queryByTestId('async-question-continue-delivery-question-a')
    ).not.toBeInTheDocument()
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() =>
      expect(
        localExecutor.request.mock.calls.filter(
          ([, params]) => (params as { method?: string }).method === 'asyncQuestion/list'
        ).length
      ).toBeGreaterThan(1)
    )
    expect(
      localExecutor.request.mock.calls.some(
        ([, params]) => (params as { method?: string }).method === 'asyncQuestion/answer'
      )
    ).toBe(false)
  })

  it('keeps multi-select option IDs visibly selected and submits those IDs', async () => {
    const user = userEvent.setup()
    const multiQuestion = question({
      questions: [{ ...question().questions[0], multiSelect: true }],
    })
    localExecutor.request.mockImplementation(
      async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { taskId: addressA.taskId, threadId: addressA.threadId, supported: true }
        const request = params as { method?: string; params?: Record<string, unknown> }
        if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [multiQuestion] }
        if (
          command === 'runtime.asyncQuestion.request' &&
          request.method === 'asyncQuestion/answer'
        )
          return {
            threadId: addressA.threadId,
            question: { ...multiQuestion, status: 'answer_saved', revision: 4, answer: {
              submissionId: String(request.params?.submissionId),
              answers: request.params?.answers as NonNullable<AsyncQuestionRecord['answer']>['answers'],
              acceptedAtMs: 2,
            } },
            accepted: true,
            duplicate: false,
          }
        throw new Error('Unexpected runtime method')
      }
    )
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))

    const option = screen.getByTestId('request-user-input-option-item-a-0')
    await user.click(option)
    expect(option).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    await waitFor(() =>
      expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute(
        'data-status',
        'answer_saved'
      )
    )
    const answerCall = localExecutor.request.mock.calls.find(([, params]) => {
      const request = params as { method?: string }
      return request.method === 'asyncQuestion/answer'
    })
    expect((answerCall?.[1] as { params?: Record<string, unknown> }).params).toMatchObject({
      answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
    })
  })

  it('shows the first authoritative answer when a competing submission loses', async () => {
    const user = userEvent.setup()
    localExecutor.request.mockImplementation(
      async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { taskId: addressA.taskId, threadId: addressA.threadId, supported: true }
        const request = params as { method?: string }
        if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [question()] }
        if (
          command === 'runtime.asyncQuestion.request' &&
          request.method === 'asyncQuestion/answer'
        )
          return {
            threadId: addressA.threadId,
            question: question({
              status: 'answer_saved',
              revision: 4,
              answer: {
                submissionId: 'winner-from-another-device',
                answers: { 'item-a': { selectedOptionIds: ['option-b'] } },
                acceptedAtMs: 4,
              },
            }),
            accepted: false,
            duplicate: false,
          }
        throw new Error('Unexpected runtime method')
      }
    )
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    const savedAnswer = await screen.findByTestId('async-question-authoritative-answer-question-a')
    expect(savedAnswer).toHaveTextContent('Which option should the task use?')
    expect(savedAnswer).toHaveTextContent('Option B')
    expect(savedAnswer).not.toHaveTextContent('Option A')
  })

  it.each(['answer', 'saved delivery'])('does not refresh an unmounted task after a delayed %s failure', async mode => {
    const user = userEvent.setup()
    const saved = question({ status: 'queued', revision: 4, answer: {
      submissionId: 'saved-submission', answers: { 'item-a': { selectedOptionIds: ['option-a'] } }, acceptedAtMs: 5,
    } })
    installExecutor(() => [mode === 'answer' ? question() : saved])
    const original = localExecutor.request.getMockImplementation()!
    let rejectAnswer!: (reason: Error) => void
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (params.method === 'asyncQuestion/answer') return new Promise((_resolve, reject) => { rejectAnswer = reject })
      return original(command, params)
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    if (mode === 'answer') {
      await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
      await user.click(screen.getByTestId('request-user-input-submit-button'))
    } else {
      await user.click(screen.getByTestId('async-question-continue-delivery-question-a'))
    }
    expect(rejectAnswer).toBeTypeOf('function')
    view.unmount()
    const callsAtUnmount = localExecutor.request.mock.calls.length
    await act(async () => { rejectAnswer(new Error('Old transport disconnected')) })
    expect(localExecutor.request).toHaveBeenCalledTimes(callsAtUnmount)
  })

  it('keeps malformed capability responses visible as read failures instead of unsupported tasks', async () => {
    localExecutor.request.mockResolvedValue({})
    const { container } = render(
      <ComposerStatusRegion>
        <AsyncQuestionPanel address={addressA} />
      </ComposerStatusRegion>
    )
    const trigger = await waitFor(() => questionStatusButton(container))
    expect(trigger).toHaveTextContent('Question status')
    expect(trigger).toHaveTextContent('Could not read question status')
    expect(localExecutor.request).toHaveBeenCalledTimes(1)
    expect(localExecutor.request).toHaveBeenCalledWith('runtime.asyncQuestion.supports', {
      deviceId: addressA.deviceId,
      taskId: addressA.taskId,
    })
  })

  it('does not show or call async RPCs when the task capability is unsupported', async () => {
    installExecutor(
      () => [question()],
      () => false
    )
    const { container } = render(<AsyncQuestionPanel address={addressA} />)
    await waitFor(() =>
      expect(localExecutor.request).toHaveBeenCalledWith('runtime.asyncQuestion.supports', {
        deviceId: addressA.deviceId,
        taskId: addressA.taskId,
      })
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(localExecutor.request).toHaveBeenCalledTimes(1)
  })

  it('ignores an old list result after the active task changes', async () => {
    let releaseOld!: (value: unknown) => void
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      const taskId = String(params.taskId)
      if (command === 'runtime.asyncQuestion.supports')
        return Promise.resolve({
          taskId,
          threadId: taskId.endsWith('thread-b') ? 'thread-b' : 'thread-a',
          supported: true,
        })
      const request = params as { method?: string }
      if (taskId === addressA.taskId && request.method === 'asyncQuestion/list')
        return new Promise(resolve => {
          releaseOld = resolve
        })
      return Promise.resolve({
        threadId: 'thread-b',
        questions: [question({ questionId: 'question-b' }, 'thread-b')],
      })
    })
    const view = render(<AsyncQuestionPanel key={addressA.taskId} address={addressA} />)
    await waitFor(() => expect(releaseOld).toBeTypeOf('function'))
    view.rerender(<AsyncQuestionPanel key={addressB.taskId} address={addressB} />)
    expect(await screen.findByTestId('async-question-card-question-b')).toBeInTheDocument()
    releaseOld({ threadId: 'thread-a', questions: [question({ questionId: 'question-old' })] })
    await waitFor(() =>
      expect(screen.queryByTestId('async-question-card-question-old')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('async-question-panel')).toHaveAttribute(
      'data-task-id',
      addressB.taskId
    )
  })

  it('later and Escape collapse the panel without losing an answer draft or submitting', async () => {
    const user = userEvent.setup()
    installExecutor()
    render(<AsyncQuestionPanel address={addressA} />)
    const toggle = await screen.findByTestId('async-question-toggle')
    await user.click(toggle)
    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    await user.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
    await user.click(toggle)
    expect(screen.getByTestId('request-user-input-option-item-a-0')).toHaveClass('bg-surface')
    const draft = screen.getByTestId('request-user-input-custom-item-a')
    await user.type(draft, 'Keep this answer for later')
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    await user.click(toggle)
    expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue(
      'Keep this answer for later'
    )
    expect(
      localExecutor.request.mock.calls.some(
        ([, params]) => (params as { method?: string }).method === 'asyncQuestion/answer'
      )
    ).toBe(false)
  })

  it('keeps an answer receipt when an earlier list read completes afterwards', async () => {
    const user = userEvent.setup()
    let resolveList!: (value: unknown) => void
    let listReads = 0
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { threadId: addressA.threadId, supported: true }
      const request = params as { method?: string; params?: Record<string, unknown> }
      if (request.method === 'asyncQuestion/list') {
        listReads += 1
        if (listReads === 1) return { threadId: addressA.threadId, questions: [question()] }
        return new Promise(resolve => { resolveList = resolve })
      }
      if (request.method === 'asyncQuestion/answer') return {
        threadId: addressA.threadId,
        accepted: true,
        duplicate: false,
        question: question({
          revision: 4,
          status: 'answer_saved',
          answer: {
            submissionId: String(request.params?.submissionId),
            answers: { 'item-a': { selectedOptionIds: ['option-a'] } },
            acceptedAtMs: 5,
          },
        }),
      }
      throw new Error('Unexpected runtime method')
    })
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.click(screen.getByTestId('async-question-refresh'))
    expect(listReads).toBe(2)
    await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
      .toHaveAttribute('data-status', 'answer_saved'))
    await act(async () => { resolveList({ threadId: addressA.threadId, questions: [question()] }) })
    expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute('data-status', 'answer_saved')
  })

  it('does not merge revisions across targets that share thread and question IDs', async () => {
    const otherAddress = { ...addressA, taskId: 'kcoder:server-b:thread-a', deviceId: 'server-b' }
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { threadId: addressA.threadId, supported: true }
      return {
        threadId: addressA.threadId,
        questions: [params.taskId === addressA.taskId
          ? question({ revision: 9, status: 'cancelled' })
          : question({ revision: 1 })],
      }
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
      .toHaveAttribute('data-status', 'cancelled'))
    view.rerender(<AsyncQuestionPanel address={otherAddress} />)
    await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
      .toHaveAttribute('data-status', 'pending'))
    expect(screen.getByTestId('async-question-panel')).toHaveAttribute('data-task-id', otherAddress.taskId)
  })

  it('coalesces notification bursts and keeps drafts until the latest list read settles', async () => {
    const user = userEvent.setup()
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    const pending: Array<{ resolve: (value: unknown) => void }> = []
    let holdReads = false
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (holdReads && command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/list')
        return new Promise(resolve => pending.push({ resolve }))
      return original(command, params)
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'Retain this answer')
    holdReads = true
    await user.click(screen.getByTestId('async-question-refresh'))
    const notify = localExecutor.subscribe.mock.calls[0][0]
    try {
      act(() => {
        for (let index = 0; index < 130; index += 1)
          notify({ event: 'async-question:changed', payload: {
            taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
            questionId: 'question-a', revision: 4,
          } })
      })
      expect(pending).toHaveLength(1)
      await act(async () => pending[0].resolve({ threadId: addressA.threadId, questions: [] }))
      await waitFor(() => expect(pending).toHaveLength(2))
      // The superseded empty list cannot remove the current card or its draft.
      expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('Retain this answer')
      expect(screen.getByTestId('async-question-refresh')).toBeDisabled()
      await act(async () => pending[1].resolve({
        threadId: addressA.threadId, questions: [question({ revision: 4 })],
      }))
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('Retain this answer')
      expect(pending).toHaveLength(2)
      expect(localExecutor.request.mock.calls.some(([, params]) =>
        params.method === 'asyncQuestion/answer')).toBe(false)
    } finally {
      view.unmount()
      await act(async () => {
        for (const read of pending) read.resolve({ threadId: addressA.threadId, questions: [] })
      })
    }
  })


  it('shows a failed trailing refresh and recovers without discarding the answer draft', async () => {
    const user = userEvent.setup()
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    let listCalls = 0
    let finish!: (value: unknown) => void
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/list') {
        listCalls += 1
        if (listCalls === 2) return new Promise(resolve => { finish = resolve })
        if (listCalls === 3) return Promise.reject(new Error('list transport failed'))
      }
      return original(command, params)
    })
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'Keep on failure')
    await user.click(screen.getByTestId('async-question-refresh'))
    act(() => localExecutor.subscribe.mock.calls[0][0]({
      event: 'async-question:changed', payload: {
        taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
      },
    }))
    await act(async () => finish({ threadId: addressA.threadId, questions: [] }))
    expect(await screen.findByTestId('async-question-summary')).toHaveTextContent('Question list refresh failed')
    expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('Keep on failure')
    expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(screen.getByTestId('async-question-summary'))
      .not.toHaveTextContent('Question list refresh failed'))
    expect(listCalls).toBe(4)
    expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('Keep on failure')
  })

  it('starts a fresh visit immediately and never lets an old read release its replacement', async () => {
    const user = userEvent.setup()
    installExecutor(taskId => taskId === addressB.taskId ? [question({}, addressB.threadId)] : [question()])
    const original = localExecutor.request.getMockImplementation()!
    const pending: Array<(value: unknown) => void> = []
    let holdReads = false
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (holdReads && command === 'runtime.asyncQuestion.request' &&
        params.taskId === addressA.taskId && params.method === 'asyncQuestion/list')
        return new Promise(resolve => pending.push(resolve))
      return original(command, params)
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    holdReads = true
    await user.click(screen.getByTestId('async-question-refresh'))
    const notifyA = () => localExecutor.subscribe.mock.calls.at(-1)![0]({
      event: 'async-question:changed', payload: {
        taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
      },
    })
    try {
      act(notifyA)
      view.rerender(<AsyncQuestionPanel address={addressB} />)
      await waitFor(() => expect(screen.getByTestId('async-question-panel'))
        .toHaveAttribute('data-task-id', addressB.taskId))
      view.rerender(<AsyncQuestionPanel address={addressA} />)
      await waitFor(() => expect(pending).toHaveLength(2))
      await act(async () => pending[0]({ threadId: addressA.threadId, questions: [question({ questionId: 'old' })] }))
      expect(screen.queryByTestId('async-question-card-old')).not.toBeInTheDocument()
      act(notifyA)
      expect(pending).toHaveLength(2)
      await act(async () => pending[1]({ threadId: addressA.threadId, questions: [] }))
      await waitFor(() => expect(pending).toHaveLength(3))
      await act(async () => pending[2]({ threadId: addressA.threadId, questions: [question()] }))
      expect(await screen.findByTestId('async-question-card-question-a')).toBeInTheDocument()
      expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    } finally {
      view.unmount()
      await act(async () => {
        for (const finish of pending) finish({ threadId: addressA.threadId, questions: [] })
      })
    }
  })

  it('drops a queued list read after the question panel unmounts', async () => {
    const user = userEvent.setup()
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    let finish!: (value: unknown) => void
    let holdReads = false
    let heldReads = 0
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (holdReads && command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/list') {
        heldReads += 1
        return new Promise(resolve => { finish = resolve })
      }
      return original(command, params)
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    holdReads = true
    await user.click(screen.getByTestId('async-question-refresh'))
    act(() => localExecutor.subscribe.mock.calls[0][0]({
      event: 'async-question:changed', payload: {
        taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
      },
    }))
    view.unmount()
    await act(async () => finish({ threadId: addressA.threadId, questions: [] }))
    expect(heldReads).toBe(1)
  })


  it('does not lose a notification in the microtask that completes the previous read', async () => {
    installExecutor()
    const original = localExecutor.request.getMockImplementation()!
    const pending: Array<(value: unknown) => void> = []
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/list')
        return new Promise(resolve => pending.push(resolve))
      return original(command, params)
    })
    const view = render(<AsyncQuestionPanel address={addressA} />)
    await waitFor(() => expect(pending).toHaveLength(1))
    try {
      await act(async () => {
        pending[0]({ threadId: addressA.threadId, questions: [question()] })
        queueMicrotask(() => localExecutor.subscribe.mock.calls[0][0]({
          event: 'async-question:changed', payload: {
            taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
          },
        }))
      })
      expect(pending).toHaveLength(2)
      await act(async () => pending[1]({ threadId: addressA.threadId, questions: [question({ revision: 4 })] }))
      expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    } finally {
      view.unmount()
      await act(async () => {
        for (const finish of pending) finish({ threadId: addressA.threadId, questions: [] })
      })
    }
  })


  it('ignores older question notifications after a newer record is displayed', async () => {
    installExecutor(() => [question({ revision: 5, status: 'cancelled' })])
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    const reads = () => localExecutor.request.mock.calls.filter(([, params]) =>
      params.method === 'asyncQuestion/list').length
    const before = reads()
    const notify = localExecutor.subscribe.mock.calls[0][0]
    for (let index = 0; index < 20; index += 1) {
      await act(async () => notify({ event: 'async-question:changed', payload: {
        taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
        questionId: 'question-a', revision: 3,
      } }))
    }
    expect(reads()).toBe(before)
    expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute('data-status', 'cancelled')
    await act(async () => notify({ event: 'async-question:changed', payload: {
      taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
      questionId: 'question-a', revision: 6,
    } }))
    expect(reads()).toBe(before + 1)
  })

  it('an older notification cannot supersede a failing refresh or hide its retry state', async () => {
    const user = userEvent.setup()
    installExecutor(() => [question({ revision: 5 })])
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'Keep this draft')
    let fail!: (error: Error) => void
    let reads = 0
    const original = localExecutor.request.getMockImplementation()!
    localExecutor.request.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.request' && params.method === 'asyncQuestion/list') {
        reads += 1
        if (reads === 1) return new Promise((_, reject) => { fail = reject })
      }
      return original(command, params)
    })
    await user.click(screen.getByTestId('async-question-refresh'))
    act(() => localExecutor.subscribe.mock.calls[0][0]({ event: 'async-question:changed', payload: {
      taskId: addressA.taskId, serverId: addressA.deviceId, threadId: addressA.threadId,
      questionId: 'question-a', revision: 3,
    } }))
    await act(async () => fail(new Error('authoritative list unavailable')))
    expect(reads).toBe(1)
    expect(screen.getByTestId('async-question-summary')).toHaveTextContent('Question list refresh failed')
    expect(screen.getByTestId('request-user-input-custom-item-a')).toHaveValue('Keep this draft')
    expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
    await user.click(screen.getByTestId('async-question-refresh'))
    await waitFor(() => expect(screen.getByTestId('async-question-summary'))
      .not.toHaveTextContent('Question list refresh failed'))
    expect(reads).toBe(2)
  })


  it.each(['free text', 'single choice replaced by text', 'multiple choice and text'])(
    'preserves answer provenance when %s equals an option ID', async mode => {
      const user = userEvent.setup()
      const original = question()
      original.questions[0].multiSelect = mode === 'multiple choice and text'
      localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
        if (command === 'runtime.asyncQuestion.supports')
          return { threadId: addressA.threadId, supported: true }
        const request = params as { method?: string; params?: Record<string, unknown> }
        if (request.method === 'asyncQuestion/list')
          return { threadId: addressA.threadId, questions: [original] }
        if (request.method === 'asyncQuestion/answer') return {
          threadId: addressA.threadId, accepted: true, duplicate: false,
          question: question({ questions: original.questions, revision: 4, status: 'answer_saved', answer: {
            submissionId: String(request.params?.submissionId),
            answers: request.params?.answers as NonNullable<AsyncQuestionRecord['answer']>['answers'],
            acceptedAtMs: 5,
          } }),
        }
        throw new Error('Unexpected runtime method')
      })
      render(<AsyncQuestionPanel address={addressA} />)
      await screen.findByTestId('async-question-card-question-a')
      await user.click(screen.getByTestId('async-question-toggle'))
      if (mode !== 'free text')
        await user.click(screen.getByTestId('request-user-input-option-item-a-0'))
      await user.type(screen.getByTestId('request-user-input-custom-item-a'), 'option-a')
      await user.click(screen.getByTestId('request-user-input-submit-button'))
      await waitFor(() => expect(screen.getByTestId('async-question-card-question-a'))
        .toHaveAttribute('data-status', 'answer_saved'))
      const answer = localExecutor.request.mock.calls.find(([, params]) =>
        (params as { method?: string }).method === 'asyncQuestion/answer')?.[1]
      expect(answer.params.answers).toEqual({ 'item-a': {
        selectedOptionIds: mode === 'multiple choice and text' ? ['option-a'] : [],
        text: 'option-a',
      } })
      expect(screen.getByTestId('async-question-authoritative-answer-question-a'))
        .toHaveTextContent('option-a')
    }
  )

  it.each([
    ['ASCII', 'x'.repeat(16 * 1024)],
    ['UTF-8', '中'.repeat(6000)],
    ['JSON escaping', '\u0001'.repeat(2800)],
  ])('rejects an oversized %s answer locally and allows a shorter answer at the same revision', async (_kind, draft) => {
    const user = userEvent.setup()
    const original = question()
    localExecutor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
      if (command === 'runtime.asyncQuestion.supports') return { threadId: addressA.threadId, supported: true }
      const request = params as { method?: string; params?: Record<string, unknown> }
      if (request.method === 'asyncQuestion/list') return { threadId: addressA.threadId, questions: [original] }
      if (request.method === 'asyncQuestion/answer') {
        const answers = request.params?.answers as NonNullable<AsyncQuestionRecord['answer']>['answers']
        // The real State limit counts the serialized map, including UTF-8 and escaping.
        if (new TextEncoder().encode(JSON.stringify(answers)).length > 16 * 1024)
          throw new Error('async answer exceeds its size limit')
        return { threadId: addressA.threadId, accepted: true, duplicate: false,
          question: question({ revision: 4, status: 'answer_saved', answer: {
            submissionId: String(request.params?.submissionId), answers, acceptedAtMs: 5,
          } }) }
      }
      throw new Error('Unexpected runtime method')
    })
    render(<AsyncQuestionPanel address={addressA} />)
    await screen.findByTestId('async-question-card-question-a')
    await user.click(screen.getByTestId('async-question-toggle'))
    const input = screen.getByTestId('request-user-input-custom-item-a')
    fireEvent.change(input, { target: { value: draft } })
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    expect(localExecutor.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(0)
    expect(await screen.findByTestId('async-question-answer-too-long')).toHaveTextContent('Shorten')
    expect(input).toHaveValue(draft)
    expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()

    // Exactly 16 KiB of persisted JSON is valid; the original pending revision remains usable.
    const overhead = new TextEncoder().encode(JSON.stringify({ 'item-a': { selectedOptionIds: [], text: '' } })).length
    fireEvent.change(input, { target: { value: 'x'.repeat(16 * 1024 - overhead) } })
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(screen.getByTestId('async-question-card-question-a')).toHaveAttribute('data-status', 'answer_saved'))
    const calls = localExecutor.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
    expect(calls).toHaveLength(1)
    expect(calls[0][1].params.expectedRevision).toBe(original.revision)
    expect(screen.queryByTestId('async-question-answer-too-long')).not.toBeInTheDocument()
  })

})
