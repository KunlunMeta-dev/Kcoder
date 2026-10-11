import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkflowConversationCanvas } from './WorkflowConversationCanvas'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
const current = () => true
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'target', isCurrent: current }),
}))
vi.mock('./workflowApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./workflowApi')>()),
  workflowApi: { read: vi.fn(), save: vi.fn(), move: vi.fn() },
}))
vi.mock('./WorkflowNodeEditor', () => ({
  WorkflowNodeEditor: () => <span data-testid="editor">Editor</span>,
}))
const graph = {
  id: 'flow',
  title: 'Draft',
  revision: 2,
  updatedAtMs: 2,
  status: 'draft',
  nodes: [{ id: 'A', title: 'First', position: { x: 0, y: 0 }, dependsOn: [] }],
} as WorkflowDefinition
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(workflowApi.read).mockResolvedValue(graph)
})
afterEach(() => vi.useRealTimers())

test('failed refresh retains selected nodes and disables mutation until reconnect', async () => {
  render(<WorkflowConversationCanvas serverId="target" definitionId="flow" active />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-node-A'))
  expect(screen.getByTestId('editor')).toBeInTheDocument()
  vi.mocked(workflowApi.read).mockRejectedValueOnce(new Error('Disconnected'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByRole('alert')).toHaveTextContent('Disconnected')
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('workflow-conversation-publish')).toBeDisabled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('workflow-conversation-publish')).toBeEnabled()
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('aria-pressed', 'true')
})

test('late revision cannot roll back newer content', async () => {
  render(<WorkflowConversationCanvas serverId="target" definitionId="flow" active />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  vi.mocked(workflowApi.read).mockResolvedValue({ ...graph, title: 'Old', revision: 1 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByRole('heading')).toHaveTextContent('Draft')
})

test('switching target aborts the old definition read and its late reply cannot replace the canvas', async () => {
  let finish!: (value: WorkflowDefinition) => void
  let oldSignal!: AbortSignal
  vi.mocked(workflowApi.read).mockImplementationOnce((_server, _id, _current, options) => {
    oldSignal = options!.signal!
    return new Promise(resolve => {
      finish = resolve
    })
  })
  const view = render(<WorkflowConversationCanvas serverId="target" definitionId="flow" active />)
  view.rerender(<WorkflowConversationCanvas serverId="other" definitionId="next" active />)
  expect(oldSignal.aborted).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    finish({ ...graph, title: 'Stale graph', revision: 100 })
  })
  expect(screen.getByRole('heading')).toHaveTextContent('Draft')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  vi.mocked(workflowApi.read).mockImplementationOnce(() => new Promise(() => {}))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  const pendingSignal = vi.mocked(workflowApi.read).mock.calls.at(-1)![3]!.signal!
  expect(pendingSignal.aborted).toBe(false)
  view.unmount()
  expect(pendingSignal.aborted).toBe(true)
})
