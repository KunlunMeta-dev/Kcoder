import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import type { RequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { PaneComposer } from './PaneComposer'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))
vi.mock('@/features/experts/TaskAgentSummary', () => ({ TaskAgentSummary: () => null }))
vi.mock('@/features/experts/TaskExpertControl', () => ({ TaskExpertControl: () => null }))
vi.mock('../BufferedChatInput', () => ({ BufferedChatInput: () => null }))
vi.mock('../DeviceStatusPrompt', () => ({ DeviceStatusPrompt: () => null }))
vi.mock('@/features/workflows/WorkflowConversationCards', () => ({
  WorkflowConversationCards: () => null,
}))

const workspacePath = '/workspace'

function question(
  id: string,
  threadId: string,
  status: AsyncQuestionRecord['status'] = 'pending',
  revision = 1
): AsyncQuestionRecord {
  return {
    questionId: id,
    requestId: `request-${id}`,
    threadId,
    sourceTurnId: `turn-${id}`,
    toolCallId: `call-${id}`,
    revision,
    createdAtMs: 1,
    status,
    questions: [
      {
        id: 'notes',
        header: 'Notes',
        question: 'What should be kept in mind?',
        multiSelect: false,
        options: [],
      },
      {
        id: 'choice',
        header: 'Delivery',
        question: 'How should this be delivered?',
        multiSelect: true,
        options: [{ id: 'review', label: 'Review first', description: '' }],
      },
    ],
    ...(status === 'context_applied'
      ? {
          answer: {
            submissionId: `submission-${id}`,
            acceptedAtMs: 2,
            answers: {
              notes: { selectedOptionIds: [], text: 'Already applied' },
              choice: { selectedOptionIds: ['review'] },
            },
          },
        }
      : {}),
  } as AsyncQuestionRecord
}

function task(taskId: string, threadId?: string, patch: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId,
    threadId,
    title: taskId,
    runtime: 'kcoder',
    status: 'failed',
    optimistic: false,
    workspacePath,
    ...patch,
  } as RuntimeTaskSummary
}

function modelFor(
  address: RuntimeTaskAddress,
  taskSummary: RuntimeTaskSummary,
  paneActive: boolean
) {
  const tracker = { current: { aliasesByKey: new Map() } as RequestUserInputAliasTracker }
  const runtimeWork = {
    projects: [],
    chats: [{ deviceId: address.deviceId, workspacePath, available: true, tasks: [taskSummary] }],
    totalTasks: 1,
  } as RuntimeWorkListResponse
  return {
    paneActive,
    paneKey: address.taskId,
    currentRuntimeTask: address,
    runtimeWork,
    workflowRefs: [],
    workflowScope: address.taskId,
    workflowComposerIntent: { active: false, onChange: vi.fn() },
    projectChatWithModelSelectorSignal: { scopeKey: address.taskId },
    t: (key: string) => key,
    paneSession: {
      requestUserInputAliasTrackerRef: tracker,
      messages: [],
      input: '',
      status: { isSubmitting: false },
      sessionMode: 'chat',
      setInput: vi.fn(),
    },
    devices: [],
    upgradingDevices: {},
    showConversationDeviceBanner: false,
    workspaceFileApi: {},
    effectiveWorkspaceTarget: { deviceId: address.deviceId, path: workspacePath },
    activeDeviceId: address.deviceId,
    } as unknown as Parameters<typeof PaneComposer>[0]['model']
}

function Pane({ model }: { model: Parameters<typeof PaneComposer>[0]['model'] }) {
  return (
    <div hidden={!model.paneActive} data-testid="cached-pane">
      <PaneComposer model={model} />
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  executor.subscribe.mockResolvedValue(vi.fn())
})

test('keeps async answer drafts in an inactive cached pane and starts later questions and owners cleanly', async () => {
  const addressA = { deviceId: 'device', taskId: 'task-a', threadId: 'thread-a', workspacePath }
  const addressB = { deviceId: 'device', taskId: 'task-b', threadId: 'thread-b', workspacePath }
  const records = new Map<string, AsyncQuestionRecord[]>([
    ['task-a', [question('shared-question-id', 'thread-a')]],
    ['task-b', [question('shared-question-id', 'thread-b')]],
  ])
  executor.request.mockImplementation(async (_command: string, params: Record<string, unknown>) => {
    const threadId = params.taskId === 'task-b' ? 'thread-b' : 'thread-a'
    if (_command === 'runtime.asyncQuestion.supports') return { supported: true, threadId }
    if (params.method === 'asyncQuestion/list') {
      return { threadId, questions: records.get(String(params.taskId)) ?? [] }
    }
    throw new Error(`Unexpected async-question operation: ${String(params.method)}`)
  })

  const modelA = modelFor(addressA, task('task-a', 'thread-a'), true)
  const view = render(<Pane model={modelA} />)
  const notes = await screen.findByTestId('request-user-input-custom-notes')
  const choice = await screen.findByTestId('request-user-input-option-choice-0')
  fireEvent.change(notes, { target: { value: 'Keep this unsent note' } })
  fireEvent.click(choice)
  expect(choice).toHaveAttribute('aria-pressed', 'true')

  const cachedNotes = notes
  const inactiveA = modelFor(addressA, task('task-a', 'thread-a'), false)
  view.rerender(<Pane model={inactiveA} />)
  expect(screen.getByTestId('cached-pane')).toHaveAttribute('hidden')
  expect(screen.getByTestId('request-user-input-custom-notes')).toBe(cachedNotes)
  expect(cachedNotes).toHaveValue('Keep this unsent note')
  expect(screen.getByTestId('request-user-input-option-choice-0')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  view.rerender(<Pane model={modelFor(addressA, task('task-a', 'thread-a'), true)} />)
  expect(screen.getByTestId('request-user-input-custom-notes')).toBe(cachedNotes)
  expect(cachedNotes).toHaveValue('Keep this unsent note')

  records.set('task-a', [
    question('shared-question-id', 'thread-a', 'context_applied', 2),
    question('next-question', 'thread-a', 'pending', 1),
  ])
  const notify = executor.subscribe.mock.calls[0][0]
  await act(async () => notify({
    event: 'async-question:changed',
    payload: {
      taskId: addressA.taskId,
      serverId: addressA.deviceId,
      threadId: addressA.threadId,
      questionId: 'next-question',
      revision: 1,
    },
  }))
  await waitFor(() => expect(screen.getByTestId('async-question-card-next-question')).toBeInTheDocument())
  const nextQuestionNote = screen.getByTestId('request-user-input-custom-notes')
  expect(nextQuestionNote).not.toBe(cachedNotes)
  expect(nextQuestionNote).toHaveValue('')
  expect(screen.getByTestId('request-user-input-option-choice-0')).toHaveAttribute(
    'aria-pressed',
    'false'
  )

  view.rerender(<Pane model={modelFor(addressB, task('task-b', 'thread-b'), true)} />)
  const ownerBNote = await screen.findByTestId('request-user-input-custom-notes')
  expect(ownerBNote).toHaveValue('')
  expect(ownerBNote).not.toBe(nextQuestionNote)
})

test('continues to suppress async questions for a client-only failed runtime draft', () => {
  const address = { deviceId: 'device', taskId: 'failed-draft', workspacePath }
  const model = modelFor(
    address,
    task('failed-draft', undefined, { optimistic: true, status: 'failed' }),
    true
  )
  render(<Pane model={model} />)

  expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
  expect(executor.request).not.toHaveBeenCalled()
})
