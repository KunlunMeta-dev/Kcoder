import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { NativeKnowledgeContent } from './NativeKnowledgeContent'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('@/features/knowledge-integration/KnowledgeIntegrationWorkspace', () => ({
  KnowledgeIntegrationWorkspace: ({ onOpenArtifacts }: { onOpenArtifacts: (run: string) => void }) =>
    <button onClick={() => onOpenArtifacts('original-run')}>open-original-run</button>,
}))
vi.mock('@/features/task-workspace/artifacts/TaskArtifactViewer', () => ({
  TaskArtifactViewer: ({ automationRunId, threadId, workflowTaskId }: { automationRunId: string; threadId: string; workflowTaskId?: string }) =>
    <div data-testid="original-export-view">{automationRunId}:{threadId}:{workflowTaskId}</div>,
}))
vi.mock('./nativeAutomationFileInputs', () => ({ nativeAutomationFileInputs: () => ({}) }))
vi.mock('./nativeWikiPublicationInputs', () => ({ nativeWikiPublicationInputs: () => ({}) }))
vi.mock('./nativeOfficeFiles', () => ({ nativeOfficeReadExport: vi.fn() }))
afterEach(cleanup)

function client() {
  return { ownerKey: 'original-owner', readRun: vi.fn(async () => ({ id: 'original-run', status: 'completed', nativeThreadId: 'original-thread', nativeTurnId: null, nativeTaskId: 'workflow-original' })),
    readRunArtifacts: vi.fn(async () => [{ kind: 'artifact', id: 'original-artifact', revision: '7' }]) } as unknown as KnowledgeIntegrationClient
}
test('opens only the selected completed automation run and its frozen artifact references', async () => {
  const actual = client()
  render(<NativeKnowledgeContent client={actual} serverId="original-target" isCurrent={() => true} />)
  fireEvent.click(screen.getByText('open-original-run'))
  await waitFor(() => expect(screen.getByTestId('original-export-view').textContent).toBe('original-run:original-thread:workflow-original'))
  expect(actual.readRun).toHaveBeenCalledWith('original-run', expect.any(AbortSignal))
  expect(actual.readRunArtifacts).toHaveBeenCalledWith('original-run', expect.any(AbortSignal))
})
test('a completed parent label without original turn or private workflow receipt cannot select child artifacts', async () => {
  const actual = client()
  vi.mocked(actual.readRun).mockResolvedValue({ id: 'original-run', status: 'completed', nativeThreadId: 'original-thread', nativeTurnId: null } as never)
  render(<NativeKnowledgeContent client={actual} serverId="original-target" isCurrent={() => true} />)
  fireEvent.click(screen.getByText('open-original-run'))
  await screen.findByTestId('knowledge-operation-error')
  expect(screen.queryByTestId('original-export-view')).toBeNull()
})
test('replacing a client with the same scope labels discards its late artifact response', async () => {
  const original = client()
  let finish!: (value: unknown) => void
  vi.mocked(original.readRun).mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish }))
  const view = render(<NativeKnowledgeContent client={original} serverId="original-target" isCurrent={() => true} />)
  fireEvent.click(screen.getByText('open-original-run'))
  const signal = vi.mocked(original.readRun).mock.calls[0][1]!
  view.rerender(<NativeKnowledgeContent client={client()} serverId="original-target" isCurrent={() => true} />)
  expect(signal.aborted).toBe(true)
  finish({ id: 'original-run', status: 'completed', nativeThreadId: 'late-original-thread' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByTestId('original-export-view')).toBeNull()
})
