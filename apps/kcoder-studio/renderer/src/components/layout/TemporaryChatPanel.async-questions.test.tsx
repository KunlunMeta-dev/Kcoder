import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import {
  createTemporaryRuntimeTaskMock,
  subscribeRuntimeTaskStreamMock,
} from './DesktopWorkbenchLayout.test-mocks'
import { renderWorkspacePanelLayout } from './DesktopWorkbenchMain.workspace.test-support'

const localExecutor = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: localExecutor.request,
  subscribeLocalExecutorEvents: localExecutor.subscribe,
}))

function question(questionId: string, itemId: string, threadId: string): AsyncQuestionRecord {
  return {
    questionId,
    requestId: `request-${questionId}`,
    threadId,
    sourceTurnId: `turn-${questionId}`,
    toolCallId: `call-${questionId}`,
    revision: 1,
    createdAtMs: 1,
    status: 'pending',
    questions: [
      {
        id: itemId,
        header: 'Decision',
        question: `How should ${questionId} proceed?`,
        multiSelect: false,
        options: [{ id: 'option-a', label: 'Option A', description: 'Continue with A' }],
      },
    ],
  } as AsyncQuestionRecord
}

function installQuestionExecutor(records: Map<string, AsyncQuestionRecord[]>) {
  localExecutor.request.mockImplementation(
    async (command: string, params: Record<string, unknown>) => {
      const taskId = String(params.taskId)
      const ownedRecords = records.get(taskId) ?? []
      const threadId = ownedRecords[0]?.threadId ?? `thread-${taskId}`
      if (command === 'runtime.asyncQuestion.supports')
        return { taskId, threadId, supported: true }

      const request = params as {
        method?: string
        params?: Record<string, unknown>
      }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/list')
        return { threadId, questions: ownedRecords }
      if (command === 'runtime.asyncQuestion.request' && request.method === 'asyncQuestion/answer') {
        const questionId = String(request.params?.questionId)
        const previous = ownedRecords.find(record => record.questionId === questionId)
        if (!previous) throw new Error(`Unknown question ${questionId}`)
        const answered = {
          ...previous,
          revision: previous.revision + 1,
          status: 'context_applied',
          answer: {
            acceptedAtMs: 10,
            submissionId: String(request.params?.submissionId),
            answers: request.params?.answers as NonNullable<AsyncQuestionRecord['answer']>['answers'],
          },
        } as AsyncQuestionRecord
        records.set(taskId, ownedRecords.map(record => record.questionId === questionId ? answered : record))
        return { accepted: true, duplicate: false, threadId, question: answered }
      }
      throw new Error(`Unexpected local executor request ${command}`)
    }
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function questionProtocolRequests() {
  return localExecutor.request.mock.calls.filter(([command]) =>
    typeof command === 'string' && command.startsWith('runtime.asyncQuestion.')
  )
}

function settleLatestTemporaryChatTurn() {
  const latestCall = subscribeRuntimeTaskStreamMock.mock.calls.at(-1)
  if (!latestCall) throw new Error('Temporary chat has not subscribed to its runtime task')
  const handlers = latestCall[1] as RuntimeTaskStreamHandlers
  act(() => handlers.onAssistantSettled?.())
}

async function openFirstChat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
  await user.click(screen.getByTestId('right-workspace-chat-option'))
}

async function addChatTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('right-workspace-new-tab-button'))
  await user.click(
    within(screen.getByTestId('right-workspace-new-tab-menu')).getByTestId(
      'right-workspace-chat-option'
    )
  )
}

async function selectChatTab(user: ReturnType<typeof userEvent.setup>, index: number) {
  const tabs = within(screen.getByTestId('right-workspace-tabbar')).getAllByRole('tab')
  await user.click(tabs[index])
}

async function showQuestion(user: ReturnType<typeof userEvent.setup>, questionId: string) {
  const panel = screen.getByTestId('right-workspace-chat-panel')
  const trigger = await within(panel).findByTestId('composer-status-trigger-questions')
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger)
  return within(panel).findByTestId(`async-question-card-${questionId}`)
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en',
    resources: { en: { chat, common } },
    interpolation: { escapeValue: false },
  })
})

beforeEach(() => {
  localExecutor.request.mockReset()
  localExecutor.subscribe.mockReset()
  localExecutor.subscribe.mockResolvedValue(vi.fn())
})

test('temporary chat waits for confirmed creation before reading asynchronous questions', async () => {
  const user = userEvent.setup()
  const address: RuntimeTaskAddress = {
    deviceId: 'workspace-cloud-device',
    taskId: 'temporary-question-task',
    threadId: 'temporary-question-thread',
    workspacePath: '/workspace/project',
  }
  const createResult = deferred<RuntimeTaskAddress | false>()
  createTemporaryRuntimeTaskMock.mockImplementation(async (_message, options) => {
    options?.onRuntimeTaskOptimisticOpen?.(address)
    return createResult.promise
  })
  installQuestionExecutor(new Map([[address.taskId, [question('question-pending', 'item-pending', address.threadId!)]]]))
  const view = renderWorkspacePanelLayout({ mainWidth: 1000 })

  try {
    await openFirstChat(user)
    const panel = screen.getByTestId('right-workspace-chat-panel')
    await user.type(within(panel).getByTestId('chat-message-input'), 'Create a temporary task')
    await user.click(within(panel).getByTestId('send-message-button'))
    await waitFor(() => expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalledWith(address, expect.any(Object)))

    expect(questionProtocolRequests()).toEqual([])
    expect(localExecutor.subscribe).not.toHaveBeenCalled()

    await act(async () => {
      createResult.resolve(address)
      await createResult.promise
    })

    await showQuestion(user, 'question-pending')
    expect(localExecutor.request).toHaveBeenCalledWith(
      'runtime.asyncQuestion.supports',
      expect.objectContaining({
        taskId: address.taskId,
        deviceId: address.deviceId,
        workspacePath: address.workspacePath,
      })
    )
    expect(localExecutor.request).toHaveBeenCalledWith(
      'runtime.asyncQuestion.request',
      expect.objectContaining({
        taskId: address.taskId,
        deviceId: address.deviceId,
        workspacePath: address.workspacePath,
        method: 'asyncQuestion/list',
        params: expect.objectContaining({ threadId: address.threadId }),
      })
    )
  } finally {
    view.unmount()
  }
})

test('temporary chat tabs keep composer drafts and question answers bound to their own task', async () => {
  const user = userEvent.setup()
  const addressA: RuntimeTaskAddress = {
    deviceId: 'workspace-cloud-device',
    taskId: 'temporary-question-task-a',
    threadId: 'temporary-question-thread-a',
    workspacePath: '/workspace/project-a',
  }
  const addressB: RuntimeTaskAddress = {
    deviceId: 'workspace-cloud-device',
    taskId: 'temporary-question-task-b',
    threadId: 'temporary-question-thread-b',
    workspacePath: '/workspace/project-b',
  }
  const byTask = new Map([
    [addressA.taskId, [question('question-a', 'item-a', addressA.threadId!)]],
    [addressB.taskId, [question('question-b', 'item-b', addressB.threadId!)]],
  ])
  const addresses = [addressA, addressB]
  createTemporaryRuntimeTaskMock.mockImplementation(async (_message, options) => {
    const address = addresses.shift()!
    options?.onRuntimeTaskOptimisticOpen?.(address)
    return address
  })
  installQuestionExecutor(byTask)
  const view = renderWorkspacePanelLayout({ mainWidth: 1000 })

  try {
    await openFirstChat(user)
    const panelA = screen.getByTestId('right-workspace-chat-panel')
    await user.type(within(panelA).getByTestId('chat-message-input'), 'Create A')
    await user.click(within(panelA).getByTestId('send-message-button'))
    await waitFor(() => expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalled())
    settleLatestTemporaryChatTurn()
    await showQuestion(user, 'question-a')
    await user.type(
      within(screen.getByTestId('right-workspace-chat-panel')).getByTestId('chat-message-input'),
      'Draft for A'
    )

    await addChatTab(user)
    const panelB = screen.getByTestId('right-workspace-chat-panel')
    await user.type(within(panelB).getByTestId('chat-message-input'), 'Create B')
    await user.click(within(panelB).getByTestId('send-message-button'))
    await waitFor(() => expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledTimes(2))
    settleLatestTemporaryChatTurn()
    await showQuestion(user, 'question-b')
    await user.type(
      within(screen.getByTestId('right-workspace-chat-panel')).getByTestId('chat-message-input'),
      'Draft for B'
    )

    await selectChatTab(user, 0)
    const activeA = screen.getByTestId('right-workspace-chat-panel')
    expect(within(activeA).getByTestId('chat-message-input')).toHaveTextContent('Draft for A')
    await showQuestion(user, 'question-a')
    const cardA = screen.getByTestId('async-question-card-question-a')
    await user.click(within(cardA).getByTestId('request-user-input-option-item-a-0'))
    await user.click(within(cardA).getByTestId('request-user-input-submit-button'))

    await waitFor(() =>
      expect(localExecutor.request).toHaveBeenCalledWith(
        'runtime.asyncQuestion.request',
        expect.objectContaining({
          taskId: addressA.taskId,
          deviceId: addressA.deviceId,
          workspacePath: addressA.workspacePath,
          method: 'asyncQuestion/answer',
          params: expect.objectContaining({ threadId: addressA.threadId, questionId: 'question-a' }),
        })
      )
    )

    await selectChatTab(user, 1)
    const activeB = screen.getByTestId('right-workspace-chat-panel')
    expect(within(activeB).getByTestId('chat-message-input')).toHaveTextContent('Draft for B')
    await showQuestion(user, 'question-b')
    expect(within(activeB).getByTestId('async-question-card-question-b')).toBeInTheDocument()
    expect(within(activeB).queryByTestId('async-question-card-question-a')).not.toBeInTheDocument()
  } finally {
    view.unmount()
  }
})

test('a late create result cannot restore question reads after the temporary tab is closed', async () => {
  const user = userEvent.setup()
  const address: RuntimeTaskAddress = {
    deviceId: 'workspace-cloud-device',
    taskId: 'temporary-question-task-disposed',
    threadId: 'temporary-question-thread-disposed',
    workspacePath: '/workspace/project',
  }
  const createResult = deferred<RuntimeTaskAddress | false>()
  createTemporaryRuntimeTaskMock.mockImplementation(async (_message, options) => {
    options?.onRuntimeTaskOptimisticOpen?.(address)
    return createResult.promise
  })
  installQuestionExecutor(new Map([[address.taskId, [question('question-disposed', 'item-disposed', address.threadId!)]]]))
  const view = renderWorkspacePanelLayout({ mainWidth: 1000 })

  try {
    await openFirstChat(user)
    const panel = screen.getByTestId('right-workspace-chat-panel')
    await user.type(within(panel).getByTestId('chat-message-input'), 'Create and then close')
    await user.click(within(panel).getByTestId('send-message-button'))
    await waitFor(() => expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalledWith(address, expect.any(Object)))

    const tabId = within(screen.getByTestId('right-workspace-tabbar'))
      .getByRole('tab').getAttribute('data-testid')
    expect(tabId).toBeTruthy()
    await user.click(screen.getByTestId(`${tabId}-close-button`))
    expect(screen.queryByTestId('right-workspace-chat-panel')).not.toBeInTheDocument()

    await act(async () => {
      createResult.resolve(address)
      await createResult.promise
    })

    expect(screen.queryByTestId('right-workspace-chat-panel')).not.toBeInTheDocument()
    expect(questionProtocolRequests()).toEqual([])
    expect(localExecutor.subscribe).not.toHaveBeenCalled()
  } finally {
    view.unmount()
  }
})
