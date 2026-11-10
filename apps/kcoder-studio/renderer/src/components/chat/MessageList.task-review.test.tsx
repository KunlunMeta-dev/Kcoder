import { reviewEvidenceFixture } from '@/features/workbench/reviewEvidence.test-support'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ToolBlock, WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { TaskReviewPanel } from './TaskReviewPanel'
import '@/i18n'
import type { TurnFileChangesCapture } from '../../../../shared/generated/contracts'
import type { TurnFileChangesSummary } from '@/types/api'

const response: WorkbenchMessage = {
  id: 'review-response',
  taskId: 'task-A',
  subtaskId: 'thread-A',
  turnId: 'turn-A',
  attemptId: 'attempt-A',
  role: 'assistant',
  status: 'done',
  content: 'The report is ready. All tests passed.',
  createdAt: '2026-10-26T00:00:00Z',
  blocks: [
    {
      id: 'write-A',
      subtaskId: 'thread-A',
      type: 'tool',
      toolName: 'write',
      toolInput: { file_path: 'report.md' },
      toolOutput: 'written',
      status: 'done',
      createdAt: 1,
      completedAt: 2,
    },
  ],
}

function command(index: number, status: ToolBlock['status'] = 'done'): ToolBlock {
  return {
    id: `check-${index}`,
    subtaskId: 'thread-A',
    type: 'tool',
    toolName: 'bash',
    toolInput: { command: `cargo test check_${index}` },
    toolOutput: `original-output-${index}`,
    status,
    createdAt: 3 + index,
    completedAt: 4 + index,
  }
}

describe('task review outside the conversation transcript', () => {
  it('opens a Native artifact with its recorded content revision', () => {
    const openFile = vi.fn()
    const review = { ...reviewEvidenceFixture, observations: [{ ...reviewEvidenceFixture.observations[0], artifacts: [{ path: '/workspace/report.md', sha256: 'b'.repeat(64) }] }] }
    render(<TaskReviewPanel message={{ ...response, reviewEvidence: review }} onOpenFile={openFile} />)
    fireEvent.click(screen.getByTestId('native-review-open-artifact'))
    expect(openFile).toHaveBeenCalledWith('/workspace/report.md', { sourceRevision: `sha256:${'b'.repeat(64)}` })
  })

  it('shows Native exit failure independently of a model completion claim, and sends only a draft reference', async () => {
    const draft = vi.fn()
    render(<TaskReviewPanel message={{ ...response, reviewEvidence: reviewEvidenceFixture }} onAddToDraft={draft} />)
    expect(screen.getByTestId('native-review-outcome')).toHaveTextContent(/退出码 1|exit code 1/)
    expect(screen.getByTestId('native-review-evidence')).toHaveTextContent(/输入版本未知|input versions are unknown/)
    await userEvent.click(screen.getByTestId('native-review-details'))
    expect(screen.getByTestId('native-review-output')).toHaveTextContent('NATIVE_CHECK_FAILED')
    await userEvent.click(screen.getByTestId('native-review-feedback'))
    expect(draft).toHaveBeenCalledTimes(1)
    expect(draft.mock.calls[0][0]).toContain('"evidenceId"')
    expect(draft.mock.calls[0][0]).toContain('"exitCode":1')
    expect(draft.mock.calls[0][0]).not.toContain('All tests passed')
  })

  it('opens acknowledged related files through the existing workspace entry without sending feedback', () => {
    const openFile = vi.fn()
    const draft = vi.fn()
    render(<TaskReviewPanel message={response} onOpenFile={openFile} onAddToDraft={draft} />)
    fireEvent.click(screen.getByTestId('task-review-open-file'))
    expect(openFile).toHaveBeenCalledWith('report.md')
    expect(screen.getByTestId('task-review-files')).toHaveTextContent(/当前文件|current file/)
    expect(draft).not.toHaveBeenCalled()
  })

  it('pages related file entries independently and keeps the selected path exact', async () => {
    const openFile = vi.fn()
    const files = Array.from({ length: 12 }, (_, index): ToolBlock => ({
      ...response.blocks![0] as ToolBlock,
      id: `write-${index}`,
      toolInput: { file_path: `report-${index}.md` },
    }))
    render(<TaskReviewPanel message={{ ...response, blocks: files }} onOpenFile={openFile} />)
    expect(screen.getAllByTestId('task-review-open-file')).toHaveLength(10)
    await userEvent.click(screen.getByTestId('task-review-files-next'))
    expect(screen.getAllByTestId('task-review-open-file')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'report-11.md' }))
    expect(openFile).toHaveBeenCalledWith('report-11.md')
  })

  it.each([
    ['partial', 'a', true],
    ['changed', 'b', true],
    ['changed', 'a', false],
  ] as const)('keeps review available with capture %s/%s, but guards the old revert action', (state, artifact, disabled) => {
    const fileChanges: TurnFileChangesSummary = {
      version: 1,
      status: 'active',
      artifact_id: 'a'.repeat(64),
      device_id: 'local',
      workspace_path: '/workspace',
      file_count: 1,
      additions: 1,
      deletions: 0,
      files: [{ path: 'report.md', change_type: 'modified', additions: 1, deletions: 0, binary: false }],
      revertible: true,
    }
    const capture: TurnFileChangesCapture = {
      version: 1,
      captureId: 'c'.repeat(64),
      threadId: 'thread-A',
      turnId: 'turn-A',
      attemptId: 'attempt-A',
      state,
      artifactId: artifact.repeat(64),
      base: { startedAtMs: 1, completedAtMs: 2 },
      head: { startedAtMs: 3, completedAtMs: 4 },
      limitations: state === 'partial' ? ['policyExclusions'] : [],
    }
    render(<MessageList
      messages={[{ ...response, fileChanges, fileChangesCapture: capture }]}
      devices={[{ id: 1, device_id: 'local', name: 'Local fixture', status: 'online', is_default: true }]}
      onLoadFileChangesDiff={vi.fn(async () => ({ diff: '', truncated: false }))}
      onRevertFileChanges={vi.fn(async () => fileChanges)}
      onOpenFileChangesReview={vi.fn()}
    />)
    expect(screen.getByTestId('revert-file-changes-button')).toHaveProperty('disabled', disabled)
    expect(screen.getByTestId('review-file-changes-button')).toBeEnabled()
  })

  it('shows capture failure on a result-only row without pretending there were no changes', () => {
    const capture: TurnFileChangesCapture = {
      version: 1,
      captureId: 'a'.repeat(64),
      threadId: 'thread-A',
      turnId: 'turn-A',
      attemptId: 'attempt-A',
      state: 'failed',
      base: null,
      head: null,
      limitations: ['captureFailed'],
      artifactId: null,
    }
    render(
      <TaskReviewPanel message={{ ...response, content: '', blocks: [], fileChangesCapture: capture }} />
    )
    expect(screen.getByTestId('task-capture-state')).toHaveAttribute('data-capture-state', 'failed')
    expect(screen.getByTestId('task-capture-state')).toHaveTextContent(/捕获失败|capture failed/)
  })

  it('adds original result references to the conversation draft without sending or retrying', () => {
    const draft = vi.fn()
    const retry = vi.fn()
    render(
      <>
        <MessageList messages={[response]} conversationKey="thread-A" onRetryFailedMessage={retry} />
        <TaskReviewPanel message={response} onAddToDraft={draft} />
      </>
    )
    expect(screen.getByTestId('task-review-no-evidence')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-review-feedback'))
    expect(draft).toHaveBeenCalledTimes(1)
    expect(draft.mock.calls[0][0]).toContain('turn: "turn-A"')
    expect(draft.mock.calls[0][0]).toContain('file: "report.md"')
    expect(draft.mock.calls[0][0]).not.toContain('All tests passed')
    expect(retry).not.toHaveBeenCalled()
  })

  it('exposes the original failed command output instead of trusting the final answer', async () => {
    render(
      <TaskReviewPanel message={{ ...response, blocks: [...response.blocks!, command(1, 'error')] }} />
    )
    const evidence = screen.getByTestId('task-review-evidence')
    expect(screen.getByTestId('task-review-failed')).toBeInTheDocument()
    expect(within(evidence).queryByText(/cargo test check_1$/)).not.toBeInTheDocument()
    await userEvent.click(within(evidence).getByText(/命令记录|Command records/))
    fireEvent.click(within(evidence).getByRole('button', { name: /cargo test check_1$/ }))
    expect(within(evidence).getByText('original-output-1')).toBeInTheDocument()
    expect(
      within(evidence).getByText(/命令完成不代表任务正确|completed command does not establish/)
    ).toBeInTheDocument()
  })

  it('paginates command evidence and keeps conversation identities separate after switching', async () => {
    const draft = vi.fn()
    const view = render(
      <TaskReviewPanel
        message={{ ...response, blocks: Array.from({ length: 11 }, (_, index) => command(index)) }}
        onAddToDraft={draft}
      />
    )
    const evidence = screen.getByTestId('task-review-evidence')
    await userEvent.click(within(evidence).getByText(/命令记录|Command records/))
    expect(within(evidence).getByText(/cargo test check_0$/)).toBeInTheDocument()
    expect(within(evidence).queryByText(/cargo test check_10$/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-review-next'))
    expect(within(evidence).getByText(/cargo test check_10$/)).toBeInTheDocument()
    const other: WorkbenchMessage = {
      ...response,
      id: 'review-other',
      taskId: 'task-B',
      subtaskId: 'thread-B',
      turnId: 'turn-B',
      attemptId: 'attempt-B',
      blocks: [command(30)],
    }
    view.rerender(
      <TaskReviewPanel message={other} onAddToDraft={draft} />
    )
    fireEvent.click(screen.getByTestId('task-review-feedback'))
    expect(draft.mock.calls[0][0]).toContain('turn: "turn-B"')
    expect(draft.mock.calls[0][0]).not.toContain('turn-A')
    expect(screen.queryByText(/cargo test check_10$/)).not.toBeInTheDocument()
  })

  it('keeps ordinary prose and streaming tasks free of a premature review panel', () => {
    const view = render(<MessageList messages={[{ ...response, blocks: [] }]} />)
    expect(screen.queryByTestId('task-review-panel')).not.toBeInTheDocument()
    view.rerender(<MessageList messages={[{ ...response, status: 'streaming' }]} />)
    expect(screen.queryByTestId('task-review-panel')).not.toBeInTheDocument()
  })

  it('keeps completed Native review facts and operations out of MessageList', () => {
    render(<MessageList messages={[{ ...response, reviewEvidence: reviewEvidenceFixture,
      blocks: [...response.blocks!, command(1, 'error')] }]} />)
    expect(screen.getByText(response.content!)).toBeInTheDocument()
    for (const testId of ['task-review-panel', 'task-review-operations', 'native-review-evidence',
      'native-review-open-artifact', 'task-review-open-comparison', 'task-review-open-delivery']) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument()
    }
  })

  it('keeps an unknown command outcome visible without creating a retry', () => {
    const retry = vi.fn()
    render(
      <>
        <MessageList messages={[{ ...response, status: 'unknown', blocks: [command(1, 'unknown')] }]} onRetryFailedMessage={retry} />
        <TaskReviewPanel message={{ ...response, status: 'unknown', blocks: [command(1, 'unknown')] }} />
      </>
    )
    expect(screen.getByTestId('task-review-unknown')).toBeInTheDocument()
    expect(retry).not.toHaveBeenCalled()
  })
})
