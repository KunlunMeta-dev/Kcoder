import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { workflowApi, type WorkflowRun } from './workflowApi'
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'scope', isCurrent: current }),
}))
const current = () => true
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./workflowApi', () => ({ workflowApi: { runs: vi.fn(), run: vi.fn(), output: vi.fn() } }))
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
  expect(workflowApi.output).toHaveBeenLastCalledWith('target', 'run', 'A', 10)
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
