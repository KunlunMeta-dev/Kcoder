import { act, renderHook } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { EMPTY_DESKTOP_REVIEW_STATE, type DesktopReviewState } from '../desktopWorkbenchPaneTypes'
import { usePanePanelActions } from './usePanePanelActions'

const target: WorkspaceTarget = { deviceId: 'review-owner', path: '/owned/review', source: 'runtime' }
const translate = (key: string) => key
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(load = vi.fn<() => Promise<string>>().mockResolvedValue('current diff')) {
  const publications = vi.fn()
  const renders = vi.fn()
  const hook = renderHook(({ workspace }) => {
    renders()
    const [reviewState, setReview] = useState<DesktopReviewState>(EMPTY_DESKTOP_REVIEW_STATE)
    const [rightPanelOpen, setRightPanelOpen] = useState(true)
    const [rightPanelView, setRightPanelView] = useState('launcher')
    const [rightPanelTabs, setRightPanelTabs] = useState<string[]>([])
    const [, setHasPreviousTurnReview] = useState(false)
    const reviewRequestSequenceRef = useRef(0)
    const previousTurnReviewRef = useRef(null)
    const setReviewState = useCallback((value: DesktopReviewState) => {
      publications(value); setReview(value)
    }, [])
    const openRightPanelTab = useCallback((tab: string) => {
      setRightPanelOpen(true); setRightPanelView(tab)
      setRightPanelTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    }, [])
    return usePanePanelActions({
      paneActive: false, paneKey: 'same-pane', workspaceTarget: workspace,
      activeDeviceId: workspace.deviceId, effectiveWorkspaceTarget: workspace,
      currentRuntimeTask: { deviceId: workspace.deviceId, taskId: 'same-task', workspacePath: workspace.path },
      paneSession: {}, t: translate, tChat: translate,
      projectChatWithModelSelectorSignal: { scopeKey: 'owned-draft' },
      environmentInfo: { branchName: 'main' }, loadEnvironmentDiff: load,
      reviewState, setReviewState, reviewRequestSequenceRef, previousTurnReviewRef,
      rightPanelOpen, setRightPanelOpen, rightPanelView, setRightPanelView,
      rightPanelTabs, setRightPanelTabs, effectiveRightPanelTabs: rightPanelTabs,
      openRightPanelTab, setHasPreviousTurnReview,
      temporaryChatInitialInputsRef: useRef(new Map()), latestPreviousTurnSubtaskId: null,
      fileEditorNavigation: { request: (work: () => void) => work() },
    } as unknown as Parameters<typeof usePanePanelActions>[0])
  }, { initialProps: { workspace: target } })
  return { ...hook, load, publications, renders }
}

test('a new empty pane does not render again just to clear an already empty review', () => {
  const f = fixture()
  expect(f.renders).toHaveBeenCalledTimes(1)
  expect(f.load).not.toHaveBeenCalled()
})

test.each(['success', 'failure'] as const)('a workspace change retires a late review %s without reading the replacement workspace', async outcome => {
  const response = deferred<string>(), f = fixture(vi.fn().mockReturnValueOnce(response.promise))
  let pending!: Promise<void>
  await act(async () => { pending = f.result.current.openEnvironmentChangesReview() })
  await act(async () => { f.rerender({ workspace: { ...target, path: '/replacement' } }) })
  const before = f.publications.mock.calls.length
  await act(async () => {
    if (outcome === 'success') response.resolve('private old workspace')
    else response.reject(new Error('private old workspace failure'))
    await pending
  })
  expect(f.publications).toHaveBeenCalledTimes(before)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.result.current.reviewState.reloadDiff).toBeUndefined()
})

test.each(['close', 'unmount', 'account', 'workspace'] as const)('a saved refresh cannot query its retired %s owner', async change => {
  const f = fixture()
  await act(async () => { await f.result.current.openEnvironmentChangesReview() })
  const refresh = f.result.current.refreshReview
  const before = f.load.mock.calls.length
  await act(async () => {
    if (change === 'close') f.result.current.closeRightPanelTab('review')
    if (change === 'unmount') f.unmount()
    if (change === 'account') notifyAccountContextChange(target.deviceId)
    if (change === 'workspace') f.rerender({ workspace: { ...target, path: '/replacement' } })
  })
  await act(async () => { refresh() })
  expect(f.load).toHaveBeenCalledTimes(before)
})

test.each(['close', 'unmount', 'account', 'aba'] as const)('a pending read cannot publish after %s', async change => {
  const response = deferred<string>(), f = fixture(vi.fn().mockReturnValueOnce(response.promise))
  let pending!: Promise<void>
  await act(async () => { pending = f.result.current.openEnvironmentChangesReview() })
  await act(async () => {
    if (change === 'close') f.result.current.closeRightPanelTab('review')
    if (change === 'unmount') f.unmount()
    if (change === 'account') notifyAccountContextChange(target.deviceId)
    if (change === 'aba') f.rerender({ workspace: { ...target, path: '/replacement' } })
  })
  if (change === 'aba') await act(async () => { f.rerender({ workspace: target }) })
  const before = f.publications.mock.calls.length
  await act(async () => { response.resolve('retired diff'); await pending })
  expect(f.publications).toHaveBeenCalledTimes(before)
})

test('a current review preserves metadata, same-workspace enrichment, refresh and current errors', async () => {
  const f = fixture()
  await act(async () => { await f.result.current.openEnvironmentChangesReview('staged') })
  const original = f.result.current.reviewState
  expect(original).toMatchObject({ loading: false, diff: 'current diff', reviewMode: 'staged', branchName: 'main' })
  await act(async () => { f.rerender({ workspace: { ...target, source: 'project' } }) })
  expect(f.result.current.reviewState).toBe(original)
  act(() => { notifyAccountContextChange('unrelated-review-device') })
  await act(async () => { f.result.current.refreshReview() })
  expect(f.load).toHaveBeenCalledTimes(2)
  f.load.mockRejectedValueOnce(new Error('current Native refusal'))
  await act(async () => { f.result.current.refreshReview() })
  expect(f.result.current.reviewState.error).toBe('current Native refusal')
})

test('Native cancellation retires the current display without showing internal cancellation text or an empty diff as fact', async () => {
  const f = fixture(vi.fn().mockRejectedValue(new DOMException('Internal owner changed', 'AbortError')))
  await act(async () => { await f.result.current.openEnvironmentChangesReview() })
  expect(f.result.current.rightPanelView).not.toBe('review')
  expect(f.result.current.reviewState.error).toBeUndefined()
  expect(f.result.current.reviewState.reloadDiff).toBeUndefined()
})

test('previous-turn metadata and truncation survive refresh through the original loader', async () => {
  const f = fixture(), read = vi.fn().mockResolvedValue({ diff: 'previous-turn diff', truncated: true })
  const metadata = { reviewTitle: 'Owned previous turn', reviewMode: 'previous-turn' as const,
    defaultFileTreeVisible: false, branchName: 'source', targetBranchName: 'destination',
    focusFilePath: 'owned.ts', sourceSubtaskId: 'owned-turn' }
  await act(async () => { await f.result.current.openReviewFromDiffLoader(read, metadata) })
  expect(f.result.current.reviewState).toMatchObject({ ...metadata, loading: false, diff: 'previous-turn diff', diffTruncated: true })
  const retiredRefresh = f.result.current.refreshReview
  await act(async () => { retiredRefresh(); retiredRefresh() })
  expect(read).toHaveBeenCalledTimes(2)
  expect(f.result.current.reviewState).toMatchObject({ ...metadata, loading: false, diffTruncated: true })
})

test.each(['account', 'workspace'] as const)('retiring review on %s preserves other panel tabs and permits a new explicit read', async change => {
  const f = fixture()
  await act(async () => { await f.result.current.openEnvironmentChangesReview() })
  act(() => { f.result.current.openRightPanelTab('files') })
  await act(async () => {
    if (change === 'account') notifyAccountContextChange(target.deviceId)
    else f.rerender({ workspace: { ...target, path: '/replacement' } })
  })
  expect(f.result.current.rightPanelView).toBe('files')
  expect(f.result.current.rightPanelTabs).toEqual(['files'])
  expect(f.result.current.reviewState.reloadDiff).toBeUndefined()
  expect(f.load).toHaveBeenCalledTimes(1)
  await act(async () => { await f.result.current.openEnvironmentChangesReview('unstaged') })
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.result.current.reviewState).toMatchObject({ loading: false, diff: 'current diff', reviewMode: 'unstaged' })
})
