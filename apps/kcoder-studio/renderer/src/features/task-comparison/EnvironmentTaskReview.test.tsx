import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchMessage } from '@/types/workbench'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import { TASK_COMPARISON_CAPABILITIES } from '@/kcoder/gatewayTaskComparison'
import { EnvironmentTaskReview } from './EnvironmentTaskReview'
import type { TaskReviewOperationsContext } from './TaskReviewOperations'
import { comparisonFixture, comparisonScope, fixtureController } from './fixtures.test-support'

function user(id: string, content: string, taskId = 'task-A'): WorkbenchMessage {
  return { id, taskId, role: 'user', status: 'done', content, createdAt: '2026-10-27T00:00:00Z' }
}
function answer(id: string, status: WorkbenchMessage['status'] = 'done', taskId = 'task-A'): WorkbenchMessage {
  return { id, taskId, role: 'assistant', status, content: 'A model description is not a check receipt.',
    turnId: comparisonScope.comparisonId, attemptId: `attempt-${id}`, createdAt: '2026-10-27T00:00:01Z',
    blocks: [{ id: `command-${id}`, type: 'tool', toolName: 'bash', toolInput: { command: 'exit 7' },
      toolOutput: status === 'unknown' ? undefined : 'exit 7', status: status === 'unknown' ? 'unknown' : 'error', createdAt: 1 },
    { id: `file-${id}`, type: 'tool', toolName: 'write', toolInput: { file_path: `${id}.md` },
      toolOutput: 'written', status: 'done', createdAt: 1 }] }
}
const messages = () => [user('u-1', 'First requirement'), answer('a-1'), user('u-2', 'Second requirement'), answer('a-2', 'unknown')]
const scope = 'account-A/target-A/task-A'
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined })

describe('controlled historical task review dialog', () => {
  it('keeps unknown outcomes and distinct response identities even when their turn ids match', () => {
    render(<EnvironmentTaskReview open onClose={vi.fn()} ownerScope={scope}
      messages={[...messages(), answer('still-running', 'streaming')]} />)
    const dialog = screen.getByRole('dialog', { name: '成果、检查与反馈' })
    expect(dialog).toHaveAttribute('data-testid', 'environment-task-review-dialog')
    const selected = screen.getByTestId('environment-task-review-result')
    expect(selected).toHaveAttribute('data-message-id', 'a-2')
    expect(selected).toHaveAttribute('data-turn-id', comparisonScope.comparisonId)
    expect(selected).toHaveAttribute('data-attempt-id', 'attempt-a-2')
    expect(screen.getByTestId('task-review-unknown')).toBeVisible()
    expect(screen.getByTestId('environment-task-review-requirement')).toHaveTextContent('Second requirement')
    const select = screen.getByRole('combobox', { name: '选择历史回复' })
    expect(select.querySelectorAll('option')).toHaveLength(2)
    fireEvent.change(select, { target: { value: select.querySelectorAll('option')[0].value } })
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-1')
    expect(screen.getByTestId('environment-task-review-requirement')).toHaveTextContent('First requirement')
    expect(screen.getByTestId('environment-task-review-scroll')).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain')
  })

  it('retains the selected response while new replies arrive or older pages are prepended', () => {
    const props = { open: true, onClose: vi.fn(), ownerScope: scope }
    const view = render(<EnvironmentTaskReview {...props} messages={messages()} />)
    const later = [...messages(), user('u-3', 'Third requirement'), answer('a-3')]
    view.rerender(<EnvironmentTaskReview {...props} messages={later} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-2')
    view.rerender(<EnvironmentTaskReview {...props} messages={[user('u-0', 'Earlier requirement'), answer('a-0'), ...later]} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-2')
    view.rerender(<EnvironmentTaskReview {...props} open={false} messages={later} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(<EnvironmentTaskReview {...props} messages={later} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-3')
  })

  it('initializes once when an open empty history first hydrates, then retains that response', () => {
    const props = { open: true, onClose: vi.fn(), ownerScope: scope }
    const view = render(<EnvironmentTaskReview {...props} messages={[]} />)
    expect(screen.queryByTestId('environment-task-review-result')).not.toBeInTheDocument()
    view.rerender(<EnvironmentTaskReview {...props} messages={messages()} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-2')
    view.rerender(<EnvironmentTaskReview {...props} messages={[...messages(), user('u-3', 'New requirement'), answer('a-3')]} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-2')
  })

  it('rebinds a replaced UI message id only to one identical Native turn and attempt', () => {
    const props = { open: true, onClose: vi.fn(), ownerScope: scope }
    const view = render(<EnvironmentTaskReview {...props} messages={messages()} />)
    const hydrated = messages().map(message => message.id === 'a-2' ? { ...message, id: 'hydrated-a-2' } : message)
    view.rerender(<EnvironmentTaskReview {...props} messages={hydrated} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'hydrated-a-2')
    const sameNative = { ...answer('a-2'), id: 'another-native-match' }
    view.rerender(<EnvironmentTaskReview {...props} messages={[...hydrated, sameNative]} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'hydrated-a-2')
    view.rerender(<EnvironmentTaskReview {...props} messages={[...messages().slice(0, 3), sameNative, { ...sameNative, id: 'ambiguous-native-match' }]} />)
    expect(screen.queryByTestId('environment-task-review-result')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('所选回复不在当前已加载历史中')
  })

  it('retains an enriched attempt identity and refuses a conflicting attempt or turn', () => {
    const props = { open: true, onClose: vi.fn(), ownerScope: scope }
    const initial = messages().map(message => message.id === 'a-2' ? { ...message, attemptId: undefined } : message)
    const view = render(<EnvironmentTaskReview {...props} messages={initial} />)
    view.rerender(<EnvironmentTaskReview {...props} messages={messages()} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-attempt-id', 'attempt-a-2')
    view.rerender(<EnvironmentTaskReview {...props} messages={messages().map(message => message.id === 'a-2' ? { ...message, attemptId: 'different-attempt' } : message)} />)
    expect(screen.queryByTestId('environment-task-review-result')).not.toBeInTheDocument()
    view.rerender(<EnvironmentTaskReview {...props} messages={messages().map(message => message.id === 'a-2' ? { ...message, turnId: 'different-turn' } : message)} />)
    expect(screen.queryByTestId('environment-task-review-result')).not.toBeInTheDocument()
  })

  it('exposes separate earlier-page and full-content loaders without substituting another selected result', async () => {
    const more = vi.fn().mockResolvedValue(undefined), full = vi.fn().mockResolvedValue(undefined)
    const props = { open: true, onClose: vi.fn(), ownerScope: scope, hasMoreBefore: true, onLoadMoreBefore: more, onLoadFullTranscript: full }
    const view = render(<EnvironmentTaskReview {...props} messages={messages()} />)
    view.rerender(<EnvironmentTaskReview {...props} messages={messages().slice(0, 2)} />)
    expect(screen.queryByTestId('environment-task-review-result')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('所选回复不在当前已加载历史中')
    fireEvent.click(screen.getByTestId('environment-task-review-load-more'))
    fireEvent.click(screen.getByTestId('environment-task-review-load-full'))
    await waitFor(() => { expect(more).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledOnce() })
    view.rerender(<EnvironmentTaskReview {...props} messages={messages()} loadingMoreBefore loadingFullTranscript />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-2')
    expect(screen.getByTestId('environment-task-review-load-more')).toBeDisabled()
    expect(screen.getByTestId('environment-task-review-load-full')).toBeDisabled()
  })

  it('uses the selected message identity for draft feedback and file opening in StrictMode', () => {
    const draft = vi.fn(), openFile = vi.fn(), close = vi.fn()
    render(<StrictMode><EnvironmentTaskReview open onClose={close} ownerScope={scope}
      messages={messages()} onAddToDraft={draft} onOpenFile={openFile} /></StrictMode>)
    fireEvent.click(screen.getByTestId('task-review-feedback'))
    expect(draft).toHaveBeenCalledWith(expect.stringContaining('message: "a-2"'))
    expect(draft).toHaveBeenCalledWith(expect.stringContaining('attempt: "attempt-a-2"'))
    fireEvent.click(screen.getByTestId('task-review-open-file'))
    expect(openFile).toHaveBeenCalledWith('a-2.md', undefined)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('resets on an explicit owner scope change and ignores late history failures from the old owner', async () => {
    let rejectOld: (error: Error) => void = () => {}
    const pending = new Promise<void>((_resolve, reject) => { rejectOld = reject })
    const full = vi.fn(() => pending)
    const props = { open: true, onClose: vi.fn(), ownerScope: scope, onLoadFullTranscript: full }
    const view = render(<EnvironmentTaskReview {...props} messages={messages()} />)
    fireEvent.click(screen.getByTestId('environment-task-review-load-full'))
    view.rerender(<EnvironmentTaskReview {...props} ownerScope="account-B/target-B/task-B"
      messages={[user('u-B', 'B requirement', 'task-B'), answer('a-B', 'done', 'task-B')]} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-message-id', 'a-B')
    await act(async () => { rejectOld(Error('old owner failed')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-task-review-requirement')).toHaveTextContent('B requirement')
  })

  it('keeps original comparison and delivery entries inside the dialog for the selected historical requirement', async () => {
    const selected = await fixtureController().select(comparisonFixture().candidates[1])
    const request = vi.fn(async (method: string) => method === TASK_COMPARISON_CAPABILITIES ? { supported: true } : selected)
    let current = true
    const draft = vi.fn()
    const context: TaskReviewOperationsContext = {
      owner: { taskId: 'task-A', threadId: comparisonScope.ownerThreadId, deviceId: comparisonScope.deviceId, scope },
      sourcePath: comparisonScope.sourcePath, availableTasks: [], isCurrent: () => current, request,
    }
    dispose = registerGatewayCommandTransport((_command, raw) => {
      const params = (raw as { params: { method: string } }).params
      if (params.method === 'capabilities') return { supported: true }
      throw Error('No model or publication action is expected')
    })
    const close = vi.fn()
    const history = [user('u-1', comparisonScope.requirement), answer('a-1'), user('u-2', 'Later requirement'), answer('a-2')]
    const view = render(<EnvironmentTaskReview open onClose={close} ownerScope={scope} taskOperations={context}
      messages={history.map(message => message.id === 'a-1' ? { ...message, attemptId: undefined } : message)}
      onAddToDraft={draft} />)
    const select = screen.getByTestId('environment-task-review-turn-select')
    fireEvent.change(select, { target: { value: select.querySelectorAll('option')[0].value } })
    fireEvent.click(screen.getByTestId('task-review-open-comparison'))
    await screen.findByText('Model says all checks passed.')
    const expanded = screen.getByTestId('task-review-open-comparison').closest('details')
    expect(expanded).toHaveAttribute('open')
    view.rerender(<EnvironmentTaskReview open onClose={close} ownerScope={scope} taskOperations={context}
      messages={history} onAddToDraft={draft} />)
    expect(screen.getByTestId('environment-task-review-result')).toHaveAttribute('data-attempt-id', 'attempt-a-1')
    expect(screen.getByTestId('task-review-open-comparison').closest('details')).toBe(expanded)
    expect(expanded).toHaveAttribute('open')
    expect(screen.getByText('Model says all checks passed.')).toBeVisible()
    fireEvent.click(screen.getByTestId('task-review-open-delivery'))
    await screen.findByTestId('task-delivery-prepare')
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ comparisonId: comparisonScope.comparisonId }))
    current = false
    fireEvent.click(screen.getByTestId('task-review-feedback'))
    expect(draft).not.toHaveBeenCalled()
  })

  it('renders a bounded empty state with the historical loader still reachable', () => {
    const more = vi.fn()
    render(<EnvironmentTaskReview open onClose={vi.fn()} ownerScope={scope} messages={[]}
      hasMoreBefore onLoadMoreBefore={more} />)
    expect(screen.getByRole('status')).toHaveTextContent('暂无已结束的回复')
    fireEvent.click(screen.getByTestId('environment-task-review-load-more'))
    expect(more).toHaveBeenCalledOnce()
  })
})
