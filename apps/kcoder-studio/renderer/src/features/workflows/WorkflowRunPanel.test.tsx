import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { requestWorkflowComposerIntent } from './useWorkflowComposerIntent'
import { navigateTo } from '@/lib/navigation'
import { workflowApi, type WorkflowRun } from './workflowApi'
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'scope', isCurrent: current }),
}))
const current = () => true
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('./workflowApi', () => ({
  workflowApi: {
    capabilities: vi.fn(async () => ({ runArchive: true })),
    archivePreview: vi.fn(),
    archiveRuns: vi.fn(),
    requests: vi.fn(async () => ({ supported: false, requests: [] })),
    runs: vi.fn(),
    run: vi.fn(),
    output: vi.fn(),
  },
}))
vi.mock('./useWorkflowComposerIntent', () => ({ requestWorkflowComposerIntent: vi.fn() }))
vi.mock('@/lib/navigation', () => ({
  buildRuntimeTaskRoute: (address: { taskId: string }) => `/task/${address.taskId}`,
  navigateTo: vi.fn(),
}))
const run: WorkflowRun = {
  revision: 2,
  runId: 'run',
  definitionId: 'flow',
  version: 1,
  threadId: 'thread',
  workspace: 'D:\\dist',
  status: 'completed',
  startedAtMs: 1,
  updatedAtMs: 2,
  resumeCount: 0,
  nodeStates: [
    {
      nodeId: 'A',
      status: 'completed',
      iteration: null,
      attempt: 1,
      startedAtMs: 1,
      finishedAtMs: 2,
      reused: true,
      outputPreview: 'preview',
      error: null,
    },
  ],
}
test('run inspector reads real run/node output pages and exposes reuse without replaying tasks', async () => {
  vi.mocked(workflowApi.runs).mockResolvedValue({ items: [{ ...run, nodeStates: [] }], total: 1 })
  vi.mocked(workflowApi.run).mockResolvedValue(run)
  vi.mocked(workflowApi.output)
    .mockResolvedValueOnce({ text: 'first page', nextOffset: 10, truncated: true })
    .mockResolvedValueOnce({ text: 'last page', truncated: false })
  const observed = vi.fn()
  render(<WorkflowRunPanel serverId="target" definitionId="flow" onSnapshot={observed} />)
  await screen.findByText('workflowCanvas.reused')
  expect(observed).toHaveBeenCalledWith(run)
  fireEvent.click(screen.getByRole('button', { name: 'workflowCanvas.nodeOutput' }))
  await screen.findByText('first page')
  fireEvent.click(screen.getByRole('button', { name: 'workflowCanvas.moreOutput' }))
  await screen.findByText('last page')
  expect(workflowApi.output).toHaveBeenLastCalledWith('target', 'run', 'A', 10, {
    signal: expect.any(AbortSignal),
  })
  expect(screen.queryByText('first page')).not.toBeInTheDocument()
})
test('unsupported run inspection displays the actual error and provides an explicit retry', async () => {
  vi.mocked(workflowApi.runs)
    .mockRejectedValueOnce(new Error('workflowRunsV1 unavailable'))
    .mockResolvedValue({ items: [], total: 0 })
  render(<WorkflowRunPanel serverId="target" definitionId="flow" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('workflowRunsV1 unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'workflowCanvas.reload' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByText('workflowCanvas.noRuns')).toBeInTheDocument()
})

test('history inspection opens a real agent without creating or resuming a run', async () => {
  vi.mocked(workflowApi.runs).mockResolvedValue({ items: [run], total: 1 })
  vi.mocked(workflowApi.run).mockResolvedValue({
    ...run,
    nodeStates: [{ ...run.nodeStates[0], agentId: 'historical-agent' }],
    interactionModified: true,
  })
  const onOpenAgent = vi.fn()
  render(<WorkflowRunPanel serverId="target" definitionId="flow" onOpenAgent={onOpenAgent} />)
  fireEvent.click(await screen.findByTestId('workflow-history-agent-A'))
  expect(screen.getByRole('status')).toHaveTextContent('workflowVerification.interactionModified')
  expect(onOpenAgent).toHaveBeenCalledWith('historical-agent', { runId: 'run', nodeId: 'A' })
})

test('recovery prepares the original conversation without automatically executing or replacing history', async () => {
  vi.mocked(workflowApi.runs).mockResolvedValue({ items: [run], total: 1 })
  vi.mocked(workflowApi.run).mockResolvedValue({ ...run, status: 'failed' })
  render(<WorkflowRunPanel serverId="target" definitionId="flow" latestSavedVersion={2} />)
  fireEvent.click(await screen.findByTestId('workflow-resume-run'))
  expect(requestWorkflowComposerIntent).toHaveBeenLastCalledWith({
    active: false,
    recovery: { runId: 'run', threadId: 'thread', deviceId: 'target', definitionId: 'flow' },
  })
  expect(navigateTo).toHaveBeenLastCalledWith('/task/kcoder:target:thread')
  fireEvent.click(screen.getByTestId('workflow-reuse-prefix'))
  expect(requestWorkflowComposerIntent).toHaveBeenLastCalledWith({
    active: false,
    recovery: {
      runId: 'run',
      threadId: 'thread',
      deviceId: 'target',
      definitionId: 'flow',
      targetVersion: 2,
    },
  })
})

test('run history archival previews selected IDs and waits for explicit confirmation', async () => {
  vi.mocked(workflowApi.runs).mockResolvedValue({ items: [run], total: 1024 })
  vi.mocked(workflowApi.run).mockResolvedValue(run)
  vi.mocked(workflowApi.archivePreview).mockResolvedValue({
    previewToken: 'stable-token',
    entries: [
      {
        runId: 'run',
        revision: 2,
        status: 'completed',
        bytes: 128,
        blockers: [],
        retainedReferences: ['verification'],
      },
    ],
    activeRecords: 1024,
    maximumRecords: 1024,
    observationBytes: 128,
    maximumObservationBytes: 67108864,
    releasableBytes: 128,
    retainedRecoveryArtifacts: true,
  })
  vi.mocked(workflowApi.archiveRuns).mockResolvedValue({
    previewToken: 'stable-token',
    archivedRunIds: ['run'],
    releasedBytes: 128,
    retainedRecoveryArtifacts: true,
    recoveryPending: false,
  })
  render(<WorkflowRunPanel serverId="target" definitionId="flow" />)
  fireEvent.click(await screen.findByTestId('workflow-run-archive-open'))
  await screen.findByTestId('workflow-run-archive-dialog')
  fireEvent.click(screen.getByTestId('workflow-run-archive-select-run'))
  fireEvent.click(screen.getByTestId('workflow-run-archive-preview'))
  await screen.findByTestId('workflow-run-archive-confirm')
  expect(workflowApi.archiveRuns).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-run-archive-confirm'))
  await waitFor(() =>
    expect(workflowApi.archiveRuns).toHaveBeenCalledWith('target', ['run'], 'stable-token', true)
  )
})
