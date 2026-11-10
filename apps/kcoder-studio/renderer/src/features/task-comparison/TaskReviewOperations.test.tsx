import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { TaskReviewPanel } from '@/components/chat/TaskReviewPanel'
import { MessageList } from '@/components/chat/MessageList'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import type { TaskDeliveryResult } from '../../../../shared/generated/contracts'
import type { WorkbenchMessage } from '@/types/workbench'
import { comparisonFixture, comparisonScope, fixtureController } from './fixtures.test-support'
import { TASK_COMPARISON_CAPABILITIES } from '@/kcoder/gatewayTaskComparison'
import type { TaskReviewOperationsContext } from './TaskReviewOperations'
import { EnvironmentTaskReview } from './EnvironmentTaskReview'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
})
const messages: WorkbenchMessage[] = [
  {
    id: 'user-A',
    taskId: 'task-A',
    role: 'user',
    status: 'done',
    createdAt: '2026-10-26T00:00:00Z',
    content: comparisonScope.requirement,
  },
  {
    id: 'answer-A',
    taskId: 'task-A',
    role: 'assistant',
    turnId: 'requirement-A',
    attemptId: 'requirement-A',
    status: 'done',
    createdAt: '2026-10-26T00:00:01Z',
    content: 'A response with no invented check claims.',
  },
]
function delivery(): TaskDeliveryResult {
  return {
    deliveryId: 'a'.repeat(64),
    threadId: 'owner-A',
    recipient: { taskId: 'task-B', threadId: 'thread-B', deviceId: 'target-A' },
    comparisonId: 'requirement-A',
    source: {
      repository: 'fixture/repo',
      branch: 'alternative/B',
      headCommit: 'b'.repeat(40),
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      diffSha256: 'c'.repeat(64),
      workingSha256: 'd'.repeat(64),
      dirty: false,
    },
    draft: { title: 'Alternative B committed change', body: 'Recorded native checks' },
    nativeEvidenceIds: [],
    request: null,
    status: {
      pushState: 'unknown',
      pullRequest: null,
      ciState: 'unknown',
      checks: [],
      sourceChanged: false,
      checksTruncated: false,
      limitation: 'notRefreshed',
    },
  }
}
describe('review operations in the task review surface', () => {
  it('retains hand-edited PR drafts after dialog close, disclosure collapse and historical response switches', async () => {
    const selected = await fixtureController().select(comparisonFixture().candidates[1])
    const requests: string[] = []
    dispose = registerGatewayCommandTransport((_command, raw) => {
      const params = (raw as { params: { method: string } }).params
      requests.push(params.method)
      if (params.method === 'capabilities') return { supported: true }
      if (params.method === 'task/delivery/prepare' || params.method === 'task/delivery/read') return delivery()
      throw Error('No publication or model invocation expected')
    })
    const context: TaskReviewOperationsContext = {
      owner: { taskId: 'task-A', threadId: 'owner-A', deviceId: 'target-A', scope: 'account-A/target-A/task-A' },
      sourcePath: '/source', availableTasks: [], isCurrent: () => true,
      request: async method => method === TASK_COMPARISON_CAPABILITIES ? { supported: true } : selected,
    }
    const history: WorkbenchMessage[] = [
      { ...messages[0]!, id: 'older-user' },
      { ...messages[1]!, id: 'older-answer', attemptId: 'older-attempt' },
      ...messages,
    ]
    const close = vi.fn()
    const props = { ownerScope: context.owner.scope, taskOperations: context, messages: history, onClose: close }
    const view = render(<EnvironmentTaskReview {...props} open />)
    const openDelivery = async () => {
      fireEvent.click(screen.getByTestId('task-review-open-delivery'))
      await screen.findByTestId('task-delivery-prepare')
    }
    await openDelivery()
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Alternative B committed change')
    fireEvent.change(screen.getByTestId('task-delivery-title'), { target: { value: 'Hand-edited PR title' } })
    fireEvent.change(screen.getByTestId('task-delivery-body'), { target: { value: 'Hand-edited PR body' } })
    fireEvent.click(screen.getByTestId('task-review-open-delivery'))
    await waitFor(() => expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument())
    await openDelivery()
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Hand-edited PR body')
    view.rerender(<EnvironmentTaskReview {...props} open={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    view.rerender(<EnvironmentTaskReview {...props} open />)
    await openDelivery()
    expect(screen.getByTestId('task-delivery-title')).toHaveValue('Hand-edited PR title')
    const select = screen.getByTestId('environment-task-review-turn-select')
    fireEvent.change(select, { target: { value: select.querySelectorAll('option')[0].value } })
    await openDelivery()
    expect(screen.queryByTestId('task-delivery-body')).not.toBeInTheDocument()
    fireEvent.change(select, { target: { value: select.querySelectorAll('option')[1].value } })
    await openDelivery()
    expect(screen.getByTestId('task-delivery-body')).toHaveValue('Hand-edited PR body')
    expect(requests.filter(method => method === 'task/delivery/prepare')).toHaveLength(1)
  })

  it('opens comparison and delivers selected B feedback to B rather than the current A draft', async () => {
    const selected = await fixtureController().select(comparisonFixture().candidates[1])
    const draftA = vi.fn()
    const draftB = vi.fn()
    const nativeRequests: Record<string, unknown>[] = []
    dispose = registerGatewayCommandTransport((_command, raw) => {
      const params = (raw as { params: Record<string, unknown> }).params
      nativeRequests.push(params)
      if (params.method === 'capabilities') return { supported: true }
      if (params.method === 'task/delivery/prepare') return delivery()
      if (params.method === 'task/delivery/request')
        return {
          ...delivery(),
          request: {
            requestId: params.requestId,
            draftSha256: 'e'.repeat(64),
            prompt: 'Publish selected B only after this explicit request.',
          },
        }
      throw new Error('unexpected native request')
    })
    const context: TaskReviewOperationsContext = {
      owner: {
        taskId: 'task-A',
        threadId: 'owner-A',
        deviceId: 'target-A',
        scope: 'account-A/target-A/task-A',
      },
      sourcePath: '/source',
      availableTasks: [],
      isCurrent: () => true,
      request: async method =>
        method === TASK_COMPARISON_CAPABILITIES ? { supported: true } : selected,
      onAddToTaskDraft: draftB,
    }
    render(
      <TaskReviewPanel message={messages[1]!} requirement={comparisonScope.requirement}
        taskOperations={context} onAddToDraft={draftA} />
    )
    fireEvent.click(screen.getByTestId('task-review-open-comparison'))
    await screen.findByText('Model says all checks passed.')
    expect(screen.getByText('检查失败')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-review-open-delivery'))
    await screen.findByTestId('task-delivery-prepare')
    fireEvent.click(screen.getByTestId('task-delivery-prepare'))
    await screen.findByDisplayValue('Alternative B committed change')
    fireEvent.click(screen.getByTestId('task-delivery-queue-publication'))
    await waitFor(() =>
      expect(draftB).toHaveBeenCalledWith('Publish selected B only after this explicit request.', {
        taskId: 'task-B',
        threadId: 'thread-B',
        deviceId: 'target-A',
      })
    )
    expect(draftA).not.toHaveBeenCalled()
    expect(nativeRequests.find(params => params.method === 'task/delivery/prepare')).toMatchObject({
      taskId: 'task-A',
      threadId: 'owner-A',
      comparisonId: 'requirement-A',
    })
  })

  it('does not put review operations or the review panel in MessageList', () => {
    render(<MessageList messages={messages} />)
    expect(screen.getByText('A response with no invented check claims.')).toBeInTheDocument()
    for (const testId of ['task-review-panel', 'task-review-operations', 'task-review-open-comparison', 'task-review-open-delivery'])
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
  })
})
