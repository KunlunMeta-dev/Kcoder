import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkflowExecutionCanvas } from './WorkflowExecutionCanvas'
import { workflowApi, type WorkflowDefinition, type WorkflowRun } from './workflowApi'
const current = () => true
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'target', isCurrent: current }),
}))
vi.mock('./workflowApi', () => ({
  workflowApi: {
    requests: vi.fn(async () => ({ supported: false, requests: [] })),
    exportDefinition: vi.fn(),
    run: vi.fn(),
    output: vi.fn(),
  },
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
  expect(workflowApi.output).toHaveBeenCalledWith('local', 'run-1', 'out', 0, {
    signal: expect.any(AbortSignal),
  })
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

afterEach(() => vi.useRealTimers())
test('live progress follows nodes, retries a failed refresh and restores cancelled runs', async () => {
  vi.useFakeTimers()
  const graphWithSteps = {
    ...graph,
    nodes: [
      { ...graph.nodes[0], id: 'A', title: 'First' },
      { ...graph.nodes[0], id: 'B', title: 'Second', position: { x: 1600, y: 600 } },
    ],
  }
  vi.mocked(workflowApi.exportDefinition).mockResolvedValue(graphWithSteps)
  const snapshot = (revision: number, status: string, a: string, b: string, resumeCount = 0) =>
    ({
      ...run,
      revision,
      status,
      resumeCount,
      nodeStates: [
        { nodeId: 'A', status: a, startedAtMs: 1 },
        { nodeId: 'B', status: b, startedAtMs: b === 'pending' ? null : 2 },
      ],
    }) as WorkflowRun
  vi.mocked(workflowApi.run).mockResolvedValue(snapshot(1, 'running', 'running', 'pending'))
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1', title: 'Saved' }}
      active
      onClose={() => {}}
    />
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByTestId('workflow-current-A')).toHaveTextContent('First')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('aria-pressed', 'true')
  vi.mocked(workflowApi.run).mockRejectedValueOnce(new Error('Temporary disconnect'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByRole('alert')).toHaveTextContent('Temporary disconnect')
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('data-run-status', 'running')
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('aria-pressed', 'true')
  vi.mocked(workflowApi.run).mockResolvedValue(snapshot(3, 'running', 'completed', 'running'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(screen.getByTestId('workflow-node-B')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('data-run-status', 'completed')
  fireEvent.click(screen.getByTestId('workflow-node-A'))
  expect(screen.getByTestId('workflow-follow-run')).toHaveAttribute('aria-pressed', 'false')
  vi.mocked(workflowApi.run).mockResolvedValue(snapshot(4, 'cancelled', 'completed', 'cancelled'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.queryByTestId('workflow-running-spinner')).not.toBeInTheDocument()
  vi.mocked(workflowApi.run).mockResolvedValue(snapshot(5, 'running', 'completed', 'running', 1))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(screen.getByTestId('workflow-follow-run')).toHaveAttribute('aria-pressed', 'true')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(screen.getByTestId('workflow-node-B')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('workflow-current-B')).toHaveTextContent('Second')
  expect(screen.queryByTestId('workflow-current-A')).not.toBeInTheDocument()
  vi.mocked(workflowApi.run).mockResolvedValue(
    snapshot(6, 'completed', 'completed', 'completed', 1)
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.queryByTestId('workflow-running-spinner')).not.toBeInTheDocument()
})

test('execution node agent action carries the actual persisted identity to its parent', async () => {
  vi.mocked(workflowApi.exportDefinition).mockResolvedValue({
    ...graph,
    nodes: [{ ...graph.nodes[0], kind: 'agent' }],
  })
  vi.mocked(workflowApi.run).mockResolvedValue({
    ...run,
    nodeStates: [{ ...run.nodeStates[0], agentId: 'real-child' }],
  })
  const onOpenAgent = vi.fn()
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1' }}
      active
      onClose={() => {}}
      onOpenAgent={onOpenAgent}
    />
  )
  fireEvent.click(await screen.findByTestId('workflow-agent-out'))
  expect(onOpenAgent).toHaveBeenCalledWith('real-child', { runId: 'run-1', nodeId: 'out' })
})

test('disconnect preserves displayed output and ignores an older recovered run revision', async () => {
  vi.useFakeTimers()
  vi.mocked(workflowApi.run).mockResolvedValue({ ...run, status: 'running', resumeCount: 0 })
  render(
    <WorkflowExecutionCanvas
      serverId="local"
      threadId="thread"
      reference={{ id: 'flow', version: 1, runId: 'run-1' }}
      active
      onClose={() => {}}
    />
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-node-out'))
  fireEvent.click(screen.getByTestId('workflow-node-output'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByText('Actual result')).toBeInTheDocument()
  vi.mocked(workflowApi.run).mockRejectedValueOnce(new Error('Lost connection'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByText('Actual result')).toBeInTheDocument()
  expect(screen.getByTestId('workflow-node-out')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByTestId('workflow-running-spinner')).not.toBeInTheDocument()
  vi.mocked(workflowApi.run).mockResolvedValue({
    ...run,
    revision: 1,
    nodeStates: [{ ...run.nodeStates[0], status: 'failed' }],
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByTestId('workflow-node-out')).toHaveAttribute('data-run-status', 'completed')
  expect(screen.getByText('Actual result')).toBeInTheDocument()
})

test('hiding a canvas aborts manual output reads and preserves its validated graph', async () => {
  let finish!: (value: { text: string; truncated: boolean }) => void
  let signal!: AbortSignal
  vi.mocked(workflowApi.output).mockImplementationOnce((_server, _run, _node, _offset, options) => {
    signal = options!.signal!
    return new Promise(resolve => {
      finish = resolve
    })
  })
  const props = {
    serverId: 'local',
    threadId: 'thread',
    reference: { id: 'flow', version: 1, runId: 'run-1' },
    onClose: vi.fn(),
  }
  const view = render(<WorkflowExecutionCanvas {...props} active />)
  await act(async () => {})
  fireEvent.click(screen.getByTestId('workflow-node-out'))
  fireEvent.click(screen.getByTestId('workflow-node-output'))
  view.rerender(<WorkflowExecutionCanvas {...props} active={false} />)
  expect(signal.aborted).toBe(true)
  await act(async () => {
    finish({ text: 'Stale output', truncated: false })
  })
  expect(screen.queryByText('Stale output')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Saved')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  view.rerender(<WorkflowExecutionCanvas {...props} active />)
  await act(async () => {})
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Saved')
  view.unmount()
})
