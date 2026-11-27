import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkflowWorkspace } from './WorkflowWorkspace'
import { requestWorkflowComposerIntent } from './useWorkflowComposerIntent'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
const current = () => true
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'target', isCurrent: current }),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { devices: [{ device_id: 'target', name: 'Target', device_type: 'local' }] },
    startNewChat: vi.fn(),
    openStandaloneWorkspace: vi.fn(),
  }),
}))
vi.mock('@/features/workbench/workbenchModelTarget', () => ({
  workbenchModelTarget: () => ({ deviceId: 'target', workspacePath: '/owned/workspace' }),
}))
vi.mock('@/components/layout/useHorizontalPaneResize', () => ({
  useHorizontalPaneResize: () => ({ width: 240, handleProps: {} }),
  PANE_RESIZE_HANDLE: '',
}))
vi.mock('./useWorkflowComposerIntent', () => ({ requestWorkflowComposerIntent: vi.fn() }))
vi.mock('./WorkflowDeleteButton', () => ({ WorkflowDeleteButton: () => null }))
vi.mock('./WorkflowRunPanel', () => ({ WorkflowRunPanel: () => null }))
vi.mock('./WorkflowLibraryActions', () => ({
  WorkflowLibraryActions: () => null,
  WorkflowImportButton: () => null,
}))
vi.mock('./WorkflowNodeEditor', () => ({
  WorkflowNodeEditor: ({ onDirty }: { onDirty: (dirty: boolean) => void }) => (
    <button data-testid="edit-node" onClick={() => onDirty(true)}>
      Edit
    </button>
  ),
}))
vi.mock('./workflowApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./workflowApi')>()),
  workflowApi: {
    list: vi.fn(),
    read: vi.fn(),
    upsert: vi.fn(),
    save: vi.fn(),
    verification: vi.fn(),
    capacity: vi.fn(),
    versionReferences: vi.fn(),
    archiveVersion: vi.fn(),
    migrateStorage: vi.fn(),
    rollbackStorage: vi.fn(),
    exportDefinition: vi.fn(),
    capabilities: vi.fn().mockResolvedValue({
      verification: false,
      storage: false,
      versionHistory: false,
      scenarios: false,
      conditionalRead: true,
    }),
  },
}))
const definition = {
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
  vi.mocked(workflowApi.capabilities).mockResolvedValue({ verification: false, storage: false,
    versionHistory: false, scenarios: false, conditionalRead: true })
  vi.mocked(workflowApi.capacity).mockReset()
  vi.mocked(workflowApi.verification).mockReset()
  vi.mocked(workflowApi.read).mockResolvedValue(definition)
  vi.mocked(workflowApi.list).mockResolvedValue({
    items: [{ ...definition, nodeCount: 1 }],
    total: 1,
    truncated: false,
  })
})
afterEach(() => vi.useRealTimers())

function advancedMetadata() {
  vi.mocked(workflowApi.read).mockResolvedValue({ ...definition, status: 'saved', savedVersion: 1 })
  vi.mocked(workflowApi.capabilities).mockResolvedValue({ verification: true, storage: true,
    versionHistory: false, scenarios: false, conditionalRead: true })
  vi.mocked(workflowApi.capacity).mockResolvedValue({ backend: 'sqlite', workflowCount: 1, workflowLimit: 100,
    savedVersionCount: 1, versionsPerWorkflowLimit: 32, usedBytes: 0, byteLimit: 1024, nearLimit: false, versions: { flow: 1 } })
  vi.mocked(workflowApi.verification).mockResolvedValue({ definitionId: 'flow', savedVersion: 1,
    draftStatus: 'saved', runs: [], totalRunCount: 0, nextOffset: null })
}
const advance = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

test('unselected and ordinary selected workflows do not poll undisplayed advanced metadata', async () => {
  advancedMetadata()
  render(<WorkflowWorkspace />)
  await advance(35_000)
  expect(workflowApi.capacity).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await advance(35_000)
  expect(workflowApi.verification).not.toHaveBeenCalled()
  expect(workflowApi.capacity).not.toHaveBeenCalled()
  expect(vi.mocked(workflowApi.capabilities).mock.calls.length).toBeGreaterThan(2)
})

test('opening advances loading immediately, polls visible metadata, and closing stops only display reads', async () => {
  advancedMetadata()
  render(<WorkflowWorkspace />)
  await advance()
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await advance()
  fireEvent.click(screen.getByTestId('workflow-advanced-toggle'))
  expect(screen.getByTestId('workflow-verification')).toHaveAttribute('aria-busy', 'true')
  await advance()
  expect(workflowApi.verification).toHaveBeenCalledOnce()
  expect(workflowApi.capacity).toHaveBeenCalledOnce()
  await advance(15_000)
  expect(workflowApi.verification).toHaveBeenCalledTimes(2)
  expect(workflowApi.capacity).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByTestId('workflow-settings-done'))
  await advance(35_000)
  expect(workflowApi.verification).toHaveBeenCalledTimes(2)
  expect(workflowApi.capacity).toHaveBeenCalledTimes(2)
  expect(vi.mocked(workflowApi.read).mock.calls.length).toBeGreaterThan(2)
})

test.each(['success', 'error'] as const)('an advanced panel reopened during a pending read discards the old %s', async outcome => {
  advancedMetadata()
  let finish!: (value: Awaited<ReturnType<typeof workflowApi.capacity>>) => void
  let fail!: (reason: Error) => void
  const currentCapacity = await workflowApi.capacity('target')
  vi.mocked(workflowApi.capacity).mockClear().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    .mockResolvedValue(currentCapacity)
  render(<WorkflowWorkspace />)
  await advance()
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await advance()
  fireEvent.click(screen.getByTestId('workflow-advanced-toggle'))
  await advance()
  fireEvent.click(screen.getByTestId('workflow-settings-done'))
  await advance()
  fireEvent.click(screen.getByTestId('workflow-advanced-toggle'))
  await advance()
  expect(workflowApi.capacity).toHaveBeenCalledTimes(2)
  await act(async () => { if (outcome === 'success') finish(currentCapacity); else fail(new Error('old metadata failure')) })
  expect(screen.getByTestId('workflow-verification')).toHaveAttribute('aria-busy', 'false')
  expect(screen.queryByText('old metadata failure')).not.toBeInTheDocument()
})

test('one failed library read preserves the dirty editor, selected node and draft until automatic recovery', async () => {
  render(<WorkflowWorkspace />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-node-A'))
  fireEvent.click(screen.getByTestId('edit-node'))
  expect(screen.getByTestId('workflow-target')).toBeDisabled()
  vi.mocked(workflowApi.read).mockRejectedValueOnce(new Error('Offline'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByTestId('workflow-error')).toHaveTextContent('Offline')
  expect(screen.getByTestId('workflow-node-A')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('edit-node')).toBeInTheDocument()
  expect(screen.getByTestId('workflow-target')).toBeDisabled()
  expect(screen.getByTestId('workflow-library-flow')).toHaveAttribute('aria-pressed', 'true')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.queryByTestId('workflow-error')).not.toBeInTheDocument()
  expect(screen.getByTestId('workflow-target')).toBeDisabled()
})

test('transient read failure prevents new writes while retaining the full canvas', async () => {
  render(<WorkflowWorkspace />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByTestId('workflow-add-node')).toBeEnabled()
  vi.mocked(workflowApi.read).mockRejectedValueOnce(new Error('Offline'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByTestId('workflow-add-node')).toBeDisabled()
  expect(screen.getByTestId('workflow-publish')).toBeDisabled()
  expect(screen.getByTestId('workflow-node-A')).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByTestId('workflow-add-node')).toBeEnabled()
})

test('actual workspace prepare reads the exact saved snapshot and transfers typed finite case without starting a task', async () => {
  const saved = {
    ...definition,
    title: 'Saved',
    status: 'saved',
    savedVersion: 1,
    inputSchema: { type: 'object', properties: { count: { type: 'number', default: 2 } } },
    nodes: [{ ...definition.nodes[0], config: { resultCheck: { source: 'return true;' } } }],
  } as WorkflowDefinition
  vi.mocked(workflowApi.read).mockResolvedValue({
    ...saved,
    status: 'draft',
    nodes: [
      ...saved.nodes,
      {
        id: 'unsaved',
        title: 'Unsaved change',
        position: { x: 10, y: 10 },
        dependsOn: [],
      } as import('./workflowApi').WorkflowNode,
    ],
  })
  vi.mocked(workflowApi.capabilities).mockResolvedValue({
    verification: true,
    storage: false,
    versionHistory: false,
    scenarios: true,
    conditionalRead: true,
  })
  vi.mocked(workflowApi.verification).mockResolvedValue({
    definitionId: 'flow',
    savedVersion: 1,
    draftStatus: 'new_draft_unverified',
    runs: [],
    totalRunCount: 0,
    nextOffset: null,
  })
  vi.mocked(workflowApi.exportDefinition).mockResolvedValue(saved)
  render(<WorkflowWorkspace />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByTestId('workflow-library-flow'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.queryByTestId('workflow-verification')).toBeNull()
  fireEvent.click(screen.getByTestId('workflow-advanced-toggle'))
  await advance()
  fireEvent.click(screen.getByTestId('workflow-prepare-verification'))
  await act(async () => {
    await Promise.resolve()
  })
  expect(workflowApi.exportDefinition).toHaveBeenCalledWith('target', 'flow', 1)
  expect(screen.getByTestId('workflow-prepare-dialog')).toBeVisible()
  expect(requestWorkflowComposerIntent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-named-case'))
  expect(screen.queryByTestId('workflow-case-check-unsaved')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workflow-case-check-A'))
  fireEvent.click(screen.getByTestId('workflow-prepare-send'))
  await act(async () => {
    await Promise.resolve()
  })
  expect(requestWorkflowComposerIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      active: false,
      run: expect.objectContaining({
        id: 'flow',
        version: 1,
        verificationScenario: { id: 'verification', requiredCheckNodes: ['A'] },
      }),
    })
  )
})
