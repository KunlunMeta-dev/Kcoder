import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { EnvironmentInfo } from '@/types/environment'
import type { RuntimeProjectWork } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { loadProjectEnvironment } from '@/api/environment'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'

const context = vi.hoisted(() => ({
  state: { devices: [], projects: [], runtimeWork: null } as Pick<WorkbenchState, 'devices' | 'projects' | 'runtimeWork'>,
  loadEnvironmentInfo: vi.fn<(...args: unknown[]) => Promise<EnvironmentInfo>>(),
  commitEnvironmentChanges: vi.fn<(...args: unknown[]) => Promise<void>>(),
  commitAndPushEnvironmentChanges: vi.fn<(...args: unknown[]) => Promise<void>>(),
  pushEnvironmentChanges: vi.fn<(...args: unknown[]) => Promise<void>>(),
  checkoutEnvironmentBranch: vi.fn<(...args: unknown[]) => Promise<void>>(),
  createEnvironmentBranch: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbenchPaneContext: () => context }))
const address = { deviceId: 'owned-device', taskId: 'owned-task', workspacePath: '/owned' }
const projectWork = {} as ProjectWorkControls
let originalVisibility: PropertyDescriptor | undefined
const show = (value: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
const snapshot: EnvironmentInfo = { additions: '+0', deletions: '-0', executionTarget: 'local',
  deviceId: address.deviceId, workspacePath: address.workspacePath }

beforeEach(() => {
  vi.useFakeTimers()
  originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  show('visible')
  context.loadEnvironmentInfo.mockReset().mockResolvedValue(snapshot)
  for (const method of ['commitEnvironmentChanges', 'commitAndPushEnvironmentChanges', 'pushEnvironmentChanges',
    'checkoutEnvironmentBranch', 'createEnvironmentBranch'] as const) context[method].mockReset().mockResolvedValue(undefined)
  context.state.projects = []
  context.state.runtimeWork = null
})
afterEach(() => {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else delete (document as Partial<Document>).visibilityState
  vi.useRealTimers()
})

test('a browser-hidden initial mount defers environment display reads until its current workspace is visible', async () => {
  show('hidden')
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork,
  }), { initialProps: { current: address } })
  try {
    await act(async () => {
      hook.rerender({ current: { ...address, workspacePath: '/foreground' } })
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(context.loadEnvironmentInfo).not.toHaveBeenCalled()
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null, expect.objectContaining({ path: '/foreground' }), { includePullRequestUrl: false })
  } finally { hook.unmount() }
})

test.each(['resolve', 'reject'] as const)('a %s from before browser hiding cannot publish a retired environment read', async outcome => {
  let finish!: (info: EnvironmentInfo) => void
  let fail!: (error: Error) => void
  context.loadEnvironmentInfo.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    .mockResolvedValue({ ...snapshot, workspacePath: '/current' })
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork,
  }), { initialProps: { current: address } })
  try {
    await act(async () => {})
    show('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    const hidden = hook.result.current.environmentInfo
    await act(async () => {
      if (outcome === 'resolve') finish(snapshot)
      else fail(new Error('Retired read failed'))
    })
    expect(hook.result.current.environmentInfo).toBe(hidden)
    await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/current' } }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    expect(hook.result.current.environmentInfo.workspacePath).toBe('/current')
  } finally { hook.unmount() }
})

test('an explicit refresh retains its forced read while the browser tab is hidden', async () => {
  show('hidden')
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
  }))
  try {
    await act(async () => {})
    context.loadEnvironmentInfo.mockClear()
    await act(async () => { await hook.result.current.refreshEnvironmentInfo() })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledExactlyOnceWith(null,
      expect.objectContaining({ path: address.workspacePath }), { force: true, includePullRequestUrl: true })
  } finally { hook.unmount() }
})

test('stream-style rerenders reuse root projection while changed roots update without metadata-only Git reads', async () => {
  let paths = ['/owned/a', '/owned/b', '/owned/a']
  const roots = vi.fn(() => paths.map(path => ({ kind: 'local', path })))
  const work: RuntimeProjectWork[] = Array.from({ length: 128 }, (_, index) => ({
    project: { id: index + 1, key: `owned-project-${index}`, name: `Owned project ${index}` },
    deviceWorkspaces: [],
  }))
  const selected = work.at(-1)!
  Object.defineProperty(selected.project, 'roots', { get: roots, configurable: true })
  selected.deviceWorkspaces = [{ deviceId: address.deviceId, workspacePath: address.workspacePath, available: true,
    tasks: [{ taskId: address.taskId, title: 'Owned task', runtime: 'kcoder', workspacePath: address.workspacePath }] }]
  context.state.runtimeWork = { projects: work, chats: [], totalTasks: 1 }
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
  }))
  try {
    await act(async () => {})
    expect(hook.result.current.environmentInfo.workspaceRoots).toEqual(['/owned/a', '/owned/b'])
    const initial = roots.mock.calls.length
    const reads = context.loadEnvironmentInfo.mock.calls.length
    expect(initial).toBeGreaterThan(0)
    const original = hook.result.current.environmentInfo.workspaceRoots
    for (let index = 0; index < 40; index++) await act(async () => { hook.rerender() })
    expect(roots).toHaveBeenCalledTimes(initial)
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(reads)
    context.state.runtimeWork = { ...context.state.runtimeWork!, projects: [...work] }
    await act(async () => { hook.rerender() })
    expect(hook.result.current.environmentInfo.workspaceRoots).toBe(original)
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(reads)
    paths = ['/owned/changed', '/owned/changed']
    context.state.runtimeWork = { ...context.state.runtimeWork, projects: [...work] }
    await act(async () => { hook.rerender() })
    expect(hook.result.current.environmentInfo.workspaceRoots).toEqual(['/owned/changed'])
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(reads + 1)
  } finally { hook.unmount() }
})

test('streaming environment reads pause while hidden and reconcile on visibility return', async () => {
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: true,
  }))
  try {
    await act(async () => {})
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    show('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(3)
  } finally { hook.unmount() }
})

test('slow Git reads settle before the next periodic refresh waits five seconds', async () => {
  let finishBranch!: (branch: string) => void
  const branch = new Promise<string>(resolve => { finishBranch = resolve })
  const executeCommand = vi.fn(async (_deviceId: string, request: { command_key: string }) => ({
    success: true,
    stderr: '',
    stdout: request.command_key === 'git_branch'
      ? await branch
      : request.command_key === 'git_branch_diff_shortstat'
        ? { additions: 0, deletions: 0, fileCount: 0, binaryFiles: 0,
          comparison: { kind: 'empty', reference: null, commit: null } }
        : '',
  }))
  const api = { executeCommand }
  context.loadEnvironmentInfo.mockImplementation((_project, target, options) =>
    loadProjectEnvironment(api, null, target as { deviceId: string; path: string }, options as { force?: boolean }))
  const branchReads = () => executeCommand.mock.calls.filter(([, request]) => request.command_key === 'git_branch').length
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: true,
  }))
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
    expect(branchReads()).toBe(1)
    await act(async () => { finishBranch('main') })
    expect(hook.result.current.environmentInfo.branchName).toBe('main')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(branchReads()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_998) })
    expect(branchReads()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(branchReads()).toBe(2)
  } finally { hook.unmount() }
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(branchReads()).toBe(2)
})

test('a retired periodic read cannot restart polling after the page returns', async () => {
  let finish!: (info: EnvironmentInfo) => void
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: true,
  }))
  try {
    await act(async () => {})
    context.loadEnvironmentInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    show('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); finish(snapshot) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(4)
  } finally { hook.unmount() }
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(4)
})

test('a turn ending while hidden still forces its final environment read once', async () => {
  const hook = renderHook(({ busy }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: busy,
  }), { initialProps: { busy: true } })
  try {
    await act(async () => {})
    show('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { hook.rerender({ busy: false }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null,
      expect.objectContaining({ deviceId: address.deviceId, path: address.workspacePath }), { force: true, includePullRequestUrl: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
  } finally { hook.unmount() }
})

test('retained hidden running pages pause environment reads and reconcile on return', async () => {
  let active = true
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: true, visible: active,
  }))
  try {
    await act(async () => {})
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    active = false
    await act(async () => { hook.rerender() })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    active = true
    await act(async () => { hook.rerender() })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(3)
  } finally { hook.unmount() }
})

test('retained hidden pages keep the final forced read without treating hiding as turn completion', async () => {
  let active = true
  const hook = renderHook(({ busy }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork, environmentRefreshActive: busy, visible: active,
  }), { initialProps: { busy: true } })
  try {
    await act(async () => {})
    active = false
    await act(async () => { hook.rerender({ busy: true }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    await act(async () => { hook.rerender({ busy: false }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
    expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null,
      expect.objectContaining({ deviceId: address.deviceId, path: address.workspacePath }), { force: true, includePullRequestUrl: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
  } finally { hook.unmount() }
})

test('a retained page mounted hidden reads only its current workspace when revealed', async () => {
  let active = false
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork, environmentRefreshActive: true, visible: active,
  }), { initialProps: { current: address } })
  try {
    await act(async () => {})
    await act(async () => {
      hook.rerender({ current: { ...address, workspacePath: '/next' } })
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(context.loadEnvironmentInfo).not.toHaveBeenCalled()
    active = true
    await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/next' } }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(1)
    expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null, expect.objectContaining({ path: '/next' }), { includePullRequestUrl: false })
  } finally { hook.unmount() }
})

test('a response retired by hiding cannot publish into a different hidden workspace', async () => {
  let active = true
  let finish!: (info: EnvironmentInfo) => void
  context.loadEnvironmentInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...snapshot, workspacePath: '/next' })
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork, environmentRefreshActive: true, visible: active,
  }), { initialProps: { current: address } })
  try {
    await act(async () => {})
    active = false
    await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/next' } }) })
    const hidden = hook.result.current.environmentInfo
    await act(async () => { finish(snapshot) })
    expect(hook.result.current.environmentInfo).toBe(hidden)
    active = true
    await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/next' } }) })
    expect(hook.result.current.environmentInfo.workspacePath).toBe('/next')
  } finally { hook.unmount() }
})

test('visibility return uses the latest workspace and a late old response cannot overwrite it', async () => {
  let finish!: (info: EnvironmentInfo) => void
  context.loadEnvironmentInfo.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...snapshot, workspacePath: '/next' })
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork, environmentRefreshActive: true,
  }), { initialProps: { current: address } })
  try {
    await act(async () => {})
    await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/next' } }) })
    expect(hook.result.current.environmentInfo.workspacePath).toBe('/next')
    show('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    show('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null, expect.objectContaining({ path: '/next' }), { includePullRequestUrl: false })
    await act(async () => { finish(snapshot) })
    expect(hook.result.current.environmentInfo.workspacePath).toBe('/next')
  } finally { hook.unmount() }
})


test.each(['commit', 'commit-and-push', 'push', 'checkout', 'create'] as const)(
  '%s publishes a fresh authoritative environment instead of optimistic facts', async action => {
    const authoritative = { ...snapshot, branchName: 'native-facts', additions: '+7', deletions: '-3' }
    const hook = renderHook(() => useWorkbenchPaneEnvironment({
      pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
    }))
    try {
      await act(async () => {})
      context.loadEnvironmentInfo.mockResolvedValue(authoritative)
      await act(async () => {
        const value = hook.result.current
        if (action === 'commit') await value.commitEnvironmentChanges('message')
        else if (action === 'commit-and-push') await value.commitAndPushEnvironmentChanges('message')
        else if (action === 'push') await value.pushEnvironmentChanges()
        else if (action === 'checkout') await value.projectWork.onCheckoutBranch!('requested-branch')
        else await value.projectWork.onCreateBranch!('requested-branch')
      })
      expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
      expect(context.loadEnvironmentInfo).toHaveBeenLastCalledWith(null,
        expect.objectContaining({ deviceId: address.deviceId, path: address.workspacePath }), { force: true, includePullRequestUrl: false })
      expect(hook.result.current.environmentInfo).toMatchObject(authoritative)
    } finally { hook.unmount() }
  }
)

test.each(['workspace', 'account'] as const)('a delayed checkout cannot refresh or publish into a replaced %s', async boundary => {
  let release!: () => void
  context.checkoutEnvironmentBranch.mockImplementation(() => new Promise(resolve => { release = resolve }))
  context.loadEnvironmentInfo.mockResolvedValue({ ...snapshot, branchName: 'current-facts' })
  const hook = renderHook(({ current }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: current, currentProject: null }, projectWork,
  }), { initialProps: { current: address } })
  let operation!: Promise<void>
  try {
    await act(async () => {})
    await act(async () => { operation = hook.result.current.projectWork.onCheckoutBranch!('old-requested') })
    if (boundary === 'workspace') {
      context.loadEnvironmentInfo.mockResolvedValue({ ...snapshot, workspacePath: '/replacement', branchName: 'current-facts' })
      await act(async () => { hook.rerender({ current: { ...address, workspacePath: '/replacement' } }) })
    } else notifyAccountContextChange(address.deviceId)
    const before = hook.result.current.environmentInfo
    const reads = context.loadEnvironmentInfo.mock.calls.length
    await act(async () => { release(); await operation })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(reads)
    expect(hook.result.current.environmentInfo).toBe(before)
  } finally { release?.(); await operation; hook.unmount() }
})


test('a failed checkout preserves its error while independently refreshing current Native facts', async () => {
  const lost = new Error('owned unknown checkout result')
  context.checkoutEnvironmentBranch.mockRejectedValue(lost)
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
  }))
  try {
    await act(async () => {})
    context.loadEnvironmentInfo.mockResolvedValue({ ...snapshot, branchName: 'native-current' })
    let received: unknown
    await act(async () => {
      try { await hook.result.current.projectWork.onCheckoutBranch!('requested') }
      catch (error) { received = error }
    })
    expect(received).toBe(lost)
    expect(context.checkoutEnvironmentBranch).toHaveBeenCalledTimes(1)
    expect(hook.result.current.environmentInfo.branchName).toBe('native-current')
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(2)
  } finally { hook.unmount() }
})


test.each([false, true])('environment cancellation is quiet while current failures remain visible (cancelled=%s)', async cancelled => {
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
  }))
  try {
    await act(async () => {})
    context.loadEnvironmentInfo.mockRejectedValueOnce(cancelled
      ? new DOMException('original read retired', 'AbortError') : new Error('current read failed'))
    await act(async () => { await hook.result.current.refreshEnvironmentInfo() })
    expect(hook.result.current.environmentInfo.loading).toBe(false)
    expect(hook.result.current.environmentInfo.error).toBe(cancelled ? undefined : 'current read failed')
  } finally { hook.unmount() }
})

test('a completed write does not restart environment reads after its pane unmounts', async () => {
  let release!: () => void
  context.checkoutEnvironmentBranch.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const hook = renderHook(() => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
  }))
  let operation!: Promise<void>
  try {
    await act(async () => {})
    await act(async () => { operation = hook.result.current.checkoutEnvironmentBranch('owned-branch') })
    hook.unmount()
    const reads = context.loadEnvironmentInfo.mock.calls.length
    await act(async () => { release(); await operation })
    expect(context.checkoutEnvironmentBranch).toHaveBeenCalledTimes(1)
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(reads)
  } finally { release?.(); await operation; hook.unmount() }
})


test('periodic summaries follow committed details demand without another open-triggered read', async () => {
  const hook = renderHook(({ details }) => useWorkbenchPaneEnvironment({
    pane: { currentRuntimeTask: address, currentProject: null }, projectWork,
    environmentRefreshActive: true, detailsVisible: () => details,
  }), { initialProps: { details: false } })
  const options = () => context.loadEnvironmentInfo.mock.calls.at(-1)?.[2]
  try {
    await act(async () => {})
    expect(options()).toMatchObject({ includePullRequestUrl: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(options()).toMatchObject({ includePullRequestUrl: false })
    const before = context.loadEnvironmentInfo.mock.calls.length
    await act(async () => { hook.rerender({ details: true }) })
    expect(context.loadEnvironmentInfo).toHaveBeenCalledTimes(before)
    await act(async () => { await hook.result.current.refreshEnvironmentInfo() })
    expect(options()).toMatchObject({ force: true, includePullRequestUrl: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(options()).toMatchObject({ includePullRequestUrl: true })
    await act(async () => { hook.rerender({ details: false }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(options()).toMatchObject({ includePullRequestUrl: false })
  } finally { hook.unmount() }
})
