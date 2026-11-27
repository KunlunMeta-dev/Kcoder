import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { useRuntimeSettingsTargets } from './useRuntimeSettingsTargets'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/kcoder/gatewayRpc', async original => {
  const actual = await original<typeof import('@/kcoder/gatewayRpc')>()
  return { ...actual, fetchGatewayServers: vi.fn() }
})

const targets: GatewayServer[] = [
  {
    id: 'target-a',
    label: 'Target A',
    description: 'A',
    runtime: 'kcoder',
    transport: 'local',
  },
  {
    id: 'target-b',
    label: 'Target B',
    description: 'B',
    runtime: 'kcoder',
    transport: 'ssh',
  },
]

function wrapper(currentTargetId: string | null) {
  const value = {
    state: {
      currentRuntimeTask: currentTargetId
        ? { deviceId: currentTargetId, taskId: 'existing-task' }
        : null,
      currentProject: null,
      runtimeWork: null,
      selectedDeviceWorkspaceId: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
    },
  } as WorkbenchContextValue
  return function TestWorkbench({ children }: { children: ReactNode }) {
    return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
  }
}

describe('useRuntimeSettingsTargets', () => {
  beforeEach(() => {
    vi.mocked(fetchGatewayServers).mockReset()
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-gateway">'
    )
  })

  afterEach(() => {
    document
      .querySelectorAll('meta[name="kcoder-rpc-token"][content="test-gateway"]')
      .forEach(node => {
        node.remove()
      })
  })

  test('defaults to the local host even when the current conversation is remote', async () => {
    vi.mocked(fetchGatewayServers).mockResolvedValue(targets)
    const { result } = renderHook(() => useRuntimeSettingsTargets(), {
      wrapper: wrapper('target-b'),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.selectedTarget).toEqual(targets[0])
    expect(result.current.selectedServerId).toBe('target-a')
    expect(result.current.currentRuntimeTarget).toEqual(targets[1])

    act(() => result.current.selectTarget('target-a'))
    expect(result.current.selectedTarget).toEqual(targets[0])
    act(() => result.current.selectTarget('unknown-target'))
    expect(result.current.selectedTarget).toEqual(targets[0])
  })

  test('selects the only configured Gateway target without needing an open session', async () => {
    vi.mocked(fetchGatewayServers).mockResolvedValue([targets[0]])
    const { result } = renderHook(() => useRuntimeSettingsTargets(), {
      wrapper: wrapper(null),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.currentRuntimeTarget).toBeNull()
    expect(result.current.selectedTarget).toEqual(targets[0])
  })

  test.each(['browser', 'retained'] as const)('%s-hidden target selectors defer display reads but keep invalidation and manual refresh', async kind => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
      .mockReturnValue(kind === 'browser' ? 'hidden' : 'visible')
    let pageActive = kind !== 'retained'
    const Workbench = wrapper(null)
    vi.mocked(fetchGatewayServers).mockResolvedValue(targets)
    const hook = renderHook(() => useRuntimeSettingsTargets(), { wrapper: ({ children }) =>
      <Workbench><RetainedPageActive.Provider value={pageActive}>{children}</RetainedPageActive.Provider></Workbench> })
    const show = async (shown: boolean) => {
      pageActive = kind !== 'retained' || shown
      visibility.mockReturnValue(kind === 'browser' && !shown ? 'hidden' : 'visible')
      await act(async () => { hook.rerender(); document.dispatchEvent(new Event('visibilitychange')) })
    }
    try {
      await act(async () => {})
      expect(fetchGatewayServers).not.toHaveBeenCalled()
      await show(true)
      await waitFor(() => expect(hook.result.current.loading).toBe(false))
      act(() => hook.result.current.selectTarget('target-b'))
      await show(false)
      await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
      expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
      expect(hook.result.current.targets).toEqual([])
      expect(hook.result.current.loading).toBe(true)
      await act(async () => { await hook.result.current.refresh() })
      expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
      expect(hook.result.current.selectedServerId).toBe('target-b')
      await show(true)
      expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
      await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
      await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(3))
      expect(hook.result.current.selectedServerId).toBe('target-b')
    } finally { hook.unmount(); visibility.mockRestore() }
  })

  test('a target reply from before tab hiding cannot restore retired targets', async () => {
    let finish!: (targets: GatewayServer[]) => void
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue([targets[1]])
    const hook = renderHook(() => useRuntimeSettingsTargets(), { wrapper: wrapper(null) })
    try {
      await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(1))
      visibility.mockReturnValue('hidden')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { finish([targets[0]]) })
      expect(hook.result.current.targets).toEqual([])
      expect(hook.result.current.loading).toBe(true)
      visibility.mockReturnValue('visible')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await waitFor(() => expect(hook.result.current.loading).toBe(false))
      expect(hook.result.current.targets).toEqual([targets[1]])
      expect(hook.result.current.selectedServerId).toBe('')
    } finally { hook.unmount(); visibility.mockRestore() }
  })

  test.each(['configuration', 'account'] as const)('a synchronous %s burst starts only the latest actual directory read', async boundary => {
    const actual = await vi.importActual<typeof import('@/kcoder/gatewayRpc')>('@/kcoder/gatewayRpc')
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ servers: targets }), { status: 200 }))
    vi.mocked(fetchGatewayServers).mockImplementation(actual.fetchGatewayServers)
    const hook = renderHook(() => useRuntimeSettingsTargets(), { wrapper: wrapper(null) })
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false))
      expect(network).toHaveBeenCalledTimes(1)
      await act(async () => {
        for (let index = 0; index < 100; index++) {
          if (boundary === 'account') notifyAccountContextChange(targets[0].id)
          else window.dispatchEvent(new Event('kcoder:servers-changed'))
        }
      })
      expect(network).toHaveBeenCalledTimes(2)
      expect(hook.result.current.targets).toEqual(targets)
      expect(hook.result.current.loading).toBe(false)
      act(() => { window.dispatchEvent(new Event('kcoder:servers-changed')); hook.unmount() })
      await act(async () => {})
      expect(network).toHaveBeenCalledTimes(2)
    } finally { hook.unmount(); network.mockRestore() }
  })

  test.each(['configuration', 'account'] as const)('%s invalidation cannot reuse a pre-change pending directory read', async boundary => {
    const actual = await vi.importActual<typeof import('@/kcoder/gatewayRpc')>('@/kcoder/gatewayRpc')
    let finishOld!: (value: Response) => void, finishCurrent!: (value: Response) => void
    const network = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishCurrent = resolve }))
    vi.mocked(fetchGatewayServers).mockImplementation(actual.fetchGatewayServers)
    const hook = renderHook(() => useRuntimeSettingsTargets(), { wrapper: wrapper(null) })
    try {
      await waitFor(() => expect(network).toHaveBeenCalledTimes(1))
      await act(async () => {
        if (boundary === 'account') notifyAccountContextChange(targets[0].id)
        else window.dispatchEvent(new Event('kcoder:servers-changed'))
      })
      expect(hook.result.current.targets).toEqual([])
      expect(network).toHaveBeenCalledTimes(2)
      expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true)
      await act(async () => { finishOld(new Response(JSON.stringify({ servers: [targets[0]] }), { status: 200 })) })
      expect(hook.result.current.targets).toEqual([])
      expect(hook.result.current.loading).toBe(true)
      await act(async () => { finishCurrent(new Response(JSON.stringify({ servers: [targets[1]] }), { status: 200 })) })
      expect(hook.result.current.targets).toEqual([targets[1]])
      expect(hook.result.current.loading).toBe(false)
    } finally {
      finishOld?.(new Response(JSON.stringify({ servers: [] }), { status: 200 }))
      finishCurrent?.(new Response(JSON.stringify({ servers: [] }), { status: 200 }))
      hook.unmount(); network.mockRestore()
    }
  })

  test('departing target selectors release only their own shared directory wait', async () => {
    const actual = await vi.importActual<typeof import('@/kcoder/gatewayRpc')>('@/kcoder/gatewayRpc')
    let finish!: (value: Response) => void
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise<Response>(resolve => { finish = resolve }))
    vi.mocked(fetchGatewayServers).mockImplementation(actual.fetchGatewayServers)
    const first = renderHook(() => useRuntimeSettingsTargets(), { wrapper: wrapper(null) })
    const peer = renderHook(() => useRuntimeSettingsTargets(), { wrapper: wrapper(null) })
    try {
      await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
      expect(network).toHaveBeenCalledTimes(1)
      first.unmount()
      expect(network.mock.calls[0][1]?.signal?.aborted).toBe(false)
      peer.unmount()
      expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true)
      await act(async () => { finish(Response.json({ servers: targets })) })
    } finally { first.unmount(); peer.unmount(); network.mockRestore() }
  })

  test.each(['browser', 'retained'] as const)('%s-hidden target selectors retire account display without reading until shown', async kind => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let pageActive = true
    const Workbench = wrapper(null)
    vi.mocked(fetchGatewayServers).mockResolvedValue(targets)
    const hook = renderHook(() => useRuntimeSettingsTargets(), { wrapper: ({ children }) =>
      <Workbench><RetainedPageActive.Provider value={pageActive}>{children}</RetainedPageActive.Provider></Workbench> })
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false))
      act(() => hook.result.current.selectTarget('target-b'))
      pageActive = kind !== 'retained'
      visibility.mockReturnValue(kind === 'browser' ? 'hidden' : 'visible')
      await act(async () => { hook.rerender(); document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { notifyAccountContextChange('target-b') })
      expect(hook.result.current.targets).toEqual([])
      expect(hook.result.current.loading).toBe(true)
      expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
      pageActive = true
      visibility.mockReturnValue('visible')
      await act(async () => { hook.rerender(); document.dispatchEvent(new Event('visibilitychange')) })
      await waitFor(() => expect(hook.result.current.loading).toBe(false))
      expect(hook.result.current.selectedServerId).toBe('target-b')
      expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
    } finally { hook.unmount(); visibility.mockRestore() }
  })

  test('disabled display demand defers automatic reads and invalidations until enabled', async () => {
    vi.mocked(fetchGatewayServers).mockResolvedValue(targets)
    const hook = renderHook(({ enabled }) => useRuntimeSettingsTargets({ enabled }), {
      initialProps: { enabled: false }, wrapper: wrapper(null),
    })
    await act(async () => {})
    expect(fetchGatewayServers).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')); notifyAccountContextChange('target-a') })
    expect(fetchGatewayServers).not.toHaveBeenCalled()
    hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
    hook.rerender({ enabled: false })
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
    expect(hook.result.current.targets).toEqual([])
    expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
    hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
  })

  test('disabling a pending demand cancels its wait and never publishes that late result', async () => {
    let finish!: (value: GatewayServer[]) => void
    vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(targets)
    const hook = renderHook(({ enabled }) => useRuntimeSettingsTargets({ enabled }), {
      initialProps: { enabled: true }, wrapper: wrapper(null),
    })
    await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(fetchGatewayServers).mock.calls[0][1]?.signal
    hook.rerender({ enabled: false })
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish(targets) })
    expect(hook.result.current.targets).toEqual([])
    hook.rerender({ enabled: true })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.targets).toEqual(targets)
    expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
  })

})
