import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { NativeKnowledgeContent } from './NativeKnowledgeContent'
import { workflowApi } from '@/features/workflows/workflowApi'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('@/features/knowledge-integration/KnowledgeIntegrationWorkspace', () => ({
  KnowledgeIntegrationWorkspace: ({ onOpenNativeRun }: { onOpenNativeRun: (run: string) => void }) =>
    <button onClick={() => onOpenNativeRun('original-run')}>open-original-workflow</button>,
}))
vi.mock('@/features/workflows/WorkflowExecutionCanvas', () => ({
  WorkflowExecutionCanvas: ({ threadId, reference }: { threadId: string; reference: { id: string; version: number; runId: string } }) =>
    <div data-testid="original-workflow-view">{threadId}:{reference.id}:{reference.version}:{reference.runId}</div>,
}))
vi.mock('@/features/workflows/workflowApi', () => ({ workflowApi: { run: vi.fn() } }))
vi.mock('./nativeAutomationFileInputs', () => ({ nativeAutomationFileInputs: () => ({}) }))
vi.mock('./nativeWikiPublicationInputs', () => ({ nativeWikiPublicationInputs: () => ({}) }))
vi.mock('./nativeOfficeFiles', () => ({ nativeOfficeReadExport: vi.fn() }))
afterEach(cleanup)
const observed = { runId: 'workflow-original', threadId: 'original-thread', definitionId: 'saved-definition', version: 3, workspace: '/owned' }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(workflowApi.run).mockResolvedValue(observed as never) })
function client() {
  return { ownerKey: 'original-owner', readRun: vi.fn(async () => ({ id: 'original-run', title: 'Original decision', status: 'waiting', nativeThreadId: 'original-thread', nativeTurnId: null, nativeTaskId: 'workflow-original' })) } as unknown as KnowledgeIntegrationClient
}
function mount(actual = client()) {
  const view = render(<NativeKnowledgeContent client={actual} serverId="original-target" workspacePath="/owned" isCurrent={() => true} />)
  fireEvent.click(screen.getByText('open-original-workflow'))
  return view
}
test('opens the original private-projected workflow run in the existing response canvas', async () => {
  const actual = client(); mount(actual)
  await waitFor(() => expect(screen.getByTestId('original-workflow-view').textContent).toBe('original-thread:saved-definition:3:workflow-original'))
  expect(actual.readRun).toHaveBeenCalledWith('original-run', expect.any(AbortSignal))
  expect(workflowApi.run).toHaveBeenCalledWith('original-target', 'workflow-original', undefined, { signal: expect.any(AbortSignal), workspacePath: '/owned' })
})
test.each([
  { runId: 'another-workflow' }, { threadId: 'another-thread' }, { workspace: '/another' }, { version: 0 }, { definitionId: null },
])('rejects a mismatched original workflow identity %j', async mismatch => {
  vi.mocked(workflowApi.run).mockResolvedValue({ ...observed, ...mismatch } as never)
  mount()
  await screen.findByTestId('knowledge-operation-error')
  expect(screen.queryByTestId('original-workflow-view')).toBeNull()
})
test('a label without the original private nativeTaskId cannot open a response canvas', async () => {
  const actual = client(); vi.mocked(actual.readRun).mockResolvedValue({ id: 'original-run', nativeThreadId: 'original-thread' } as never)
  mount(actual)
  await screen.findByTestId('knowledge-operation-error')
  expect(workflowApi.run).not.toHaveBeenCalled()
})
test('replacing an equal-label client discards its late original workflow observation', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(workflowApi.run).mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish }))
  const view = mount()
  await waitFor(() => expect(workflowApi.run).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(workflowApi.run).mock.calls[0][3]!.signal!
  view.rerender(<NativeKnowledgeContent client={client()} serverId="original-target" workspacePath="/owned" isCurrent={() => true} />)
  expect(signal.aborted).toBe(true)
  finish(observed)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByTestId('original-workflow-view')).toBeNull()
})


test('a selected target/workspace change aborts the prior run lookup without redirecting its late reply', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(workflowApi.run).mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish }))
  const actual = client(), view = mount(actual)
  await waitFor(() => expect(workflowApi.run).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(workflowApi.run).mock.calls[0][3]!.signal!
  view.rerender(<NativeKnowledgeContent client={actual} serverId="another-target" workspacePath="/another" isCurrent={() => true} />)
  expect(signal.aborted).toBe(true)
  finish(observed)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByTestId('original-workflow-view')).toBeNull()
  expect(vi.mocked(workflowApi.run).mock.calls.every(([target]) => target === 'original-target')).toBe(true)
})
