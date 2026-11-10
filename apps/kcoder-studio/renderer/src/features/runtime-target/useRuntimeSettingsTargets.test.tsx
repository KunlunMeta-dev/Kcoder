import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { useRuntimeSettingsTargets } from './useRuntimeSettingsTargets'

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
})
