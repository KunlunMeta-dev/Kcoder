import { act, render, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import * as diagnostics from '@/lib/debugPanel'
import type { WorkbenchMessage } from '@/types/workbench'
import { usePaneDiagnostics } from './usePaneDiagnostics'
import type { usePaneGoal } from './usePaneGoal'
import { CachedWorkbenchPaneStack } from '../workbenchPaneStack'
import type { WorkbenchPaneIdentity } from '../workbenchPaneIdentity'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function contextFor(taskId: string, text = 'First text') {
  const message: WorkbenchMessage = { id: 'reply', role: 'assistant', status: 'streaming',
    content: text, createdAt: '2026-11-22T00:00:00Z' }
  return { currentRuntimeTask: { deviceId: 'target', taskId }, codeCommentContexts: [],
    input: '', turnNavigation: [], messages: [message], loadedTranscriptRanges: [],
    transcriptLoading: false } as unknown as ReturnType<typeof usePaneGoal>
}

test('streaming updates defer diagnostic traversal until a snapshot is requested', () => {
  const summaries = vi.spyOn(diagnostics, 'summarizeMessages')
  const comparisons = vi.spyOn(diagnostics, 'compareMessageStyles')
  const memory = vi.spyOn(diagnostics, 'summarizeRuntimePaneMemory')
  const pane = renderHook(context => usePaneDiagnostics(context), { initialProps: contextFor('original') })
  for (let index = 1; index <= 12; index++) pane.rerender(contextFor('original', `Text ${index}`))
  expect(summaries).not.toHaveBeenCalled()
  expect(comparisons).not.toHaveBeenCalled()
  expect(memory).not.toHaveBeenCalled()
  const snapshot = diagnostics.getWorkbenchDebugSnapshot().pane!
  expect(snapshot.currentRuntimeTask?.taskId).toBe('original')
  expect(snapshot.messageSummary.total).toBe(1)
  expect(snapshot.messageStyleComparison.currentStreaming?.contentPreview).toBe('Text 12')
  expect(summaries).toHaveBeenCalledTimes(1)
  pane.rerender(contextFor('replacement', 'Current task'))
  expect(summaries).toHaveBeenCalledTimes(1)
  const current = diagnostics.getWorkbenchDebugSnapshot().pane!
  expect(current.currentRuntimeTask?.taskId).toBe('replacement')
  expect(current.messageStyleComparison.currentStreaming?.contentPreview).toBe('Current task')
  expect(summaries).toHaveBeenCalledTimes(2)
  pane.unmount()
  expect(diagnostics.getWorkbenchDebugSnapshot().pane).toBeNull()
  expect(summaries).toHaveBeenCalledTimes(2)
})

test('unmounting a previous pane cannot clear the current diagnostic owner', () => {
  const previous = renderHook(() => usePaneDiagnostics(contextFor('previous')))
  const current = renderHook(() => usePaneDiagnostics(contextFor('current')))
  previous.unmount()
  expect(diagnostics.getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.taskId).toBe('current')
  current.unmount()
  expect(diagnostics.getWorkbenchDebugSnapshot().pane).toBeNull()
})

test('snapshot update time identifies the committed input, not the later read', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-22T00:00:00Z'))
  const pane = renderHook(context => usePaneDiagnostics(context), { initialProps: contextFor('task') })
  const published = diagnostics.getWorkbenchDebugSnapshot().pane!.updatedAt
  act(() => { vi.advanceTimersByTime(1000) })
  expect(diagnostics.getWorkbenchDebugSnapshot().pane!.updatedAt).toBe(published)
  pane.rerender(contextFor('task', 'Updated content'))
  expect(diagnostics.getWorkbenchDebugSnapshot().pane!.updatedAt).not.toBe(published)
})

test('cached inactive panes cannot replace diagnostics, and switching back registers current data', () => {
  const previous = { currentRuntimeTask: { deviceId: 'target', taskId: 'previous' }, currentProject: null }
  const current = { currentRuntimeTask: { deviceId: 'target', taskId: 'current' }, currentProject: null }
  const contexts = new Map([['previous', contextFor('previous')], ['current', contextFor('current')]])
  function Probe({ pane }: { pane: WorkbenchPaneIdentity }) {
    usePaneDiagnostics(contexts.get(pane.currentRuntimeTask!.taskId)!)
    return null
  }
  const stack = (pane: WorkbenchPaneIdentity) => <CachedWorkbenchPaneStack activePane={pane}
    maxPanes={2} pinnedKeys={[]} prunedKeys={[]}
    validRuntimeKeys={['runtime:target:previous', 'runtime:target:current']} activeTestId="active-pane"
    renderPane={identity => <Probe pane={identity} />} />
  const view = render(stack(previous))
  view.rerender(stack(current))
  expect(diagnostics.getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.taskId).toBe('current')
  contexts.set('previous', contextFor('previous', 'Hidden update'))
  view.rerender(stack(current))
  expect(diagnostics.getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.taskId).toBe('current')
  view.rerender(stack(previous))
  expect(diagnostics.getWorkbenchDebugSnapshot().pane?.messageStyleComparison.currentStreaming?.contentPreview).toBe('Hidden update')
})
