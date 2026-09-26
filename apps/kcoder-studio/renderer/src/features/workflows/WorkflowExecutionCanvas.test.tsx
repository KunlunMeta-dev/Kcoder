import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WorkflowExecutionCanvas } from './WorkflowExecutionCanvas'
import { workflowApi, type WorkflowDefinition, type WorkflowRun } from './workflowApi'
const current = () => true
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'target', isCurrent: current }),
}))
vi.mock('./workflowApi', () => ({
  workflowApi: { exportDefinition: vi.fn(), run: vi.fn(), output: vi.fn() },
}))
const graph = {
  id: 'flow',
  title: 'Saved',
  savedVersion: 1,
  status: 'saved',
  nodes: [
    {
      id: 'out',
      kind: 'output',
      title: 'Output',
      prompt: 'Result',
      position: { x: 0, y: 0 },
      dependsOn: [],
      expectedArtifacts: [],
    },
  ],
} as WorkflowDefinition
const run = {
  runId: 'run-1',
  definitionId: 'flow',
  version: 1,
  threadId: 'thread',
  revision: 3,
  status: 'completed',
  nodeStates: [{ nodeId: 'out', status: 'completed' }],
} as WorkflowRun
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(workflowApi.exportDefinition).mockResolvedValue(graph)
  vi.mocked(workflowApi.run).mockResolvedValue(run)
  vi.mocked(workflowApi.output).mockResolvedValue({ text: 'Actual result', truncated: false })
})
test('shows only the exact pinned run and reads its actual node output', async () => {
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="kcoder:local:thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1', title: 'Saved' }}
      active
      onClose={() => {}}
    />
  )
  fireEvent.click(await screen.findByTestId('workflow-node-out'))
  fireEvent.click(screen.getByTestId('workflow-node-output'))
  expect(await screen.findByText('Actual result')).toBeInTheDocument()
  expect(workflowApi.output).toHaveBeenCalledWith('local', 'run-1', 'out', 0)
  expect(screen.queryByTestId('workflow-conversation-publish')).not.toBeInTheDocument()
})
test('a mismatched conversation run never appears as this conversation success', async () => {
  vi.mocked(workflowApi.run).mockResolvedValue({ ...run, threadId: 'someone-else' })
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1', title: 'Saved' }}
      active
      onClose={() => {}}
    />
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('workflowFlow.runMismatch')
  expect(screen.queryByTestId('workflow-node-out')).not.toBeInTheDocument()
})

test('failed runs select the failed node and expose its actual error', async () => {
  vi.mocked(workflowApi.run).mockResolvedValue({
    ...run,
    status: 'failed',
    error: 'Run stopped',
    nodeStates: [{ ...run.nodeStates[0], status: 'failed', error: 'Node failed with evidence' }],
  })
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1', title: 'Saved' }}
      active
      onClose={() => {}}
    />
  )
  expect(await screen.findByText('Node failed with evidence')).toBeInTheDocument()
  expect(screen.getByTestId('workflow-node-out')).toHaveAttribute('aria-pressed', 'true')
})
