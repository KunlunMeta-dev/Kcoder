import { currentHostServer } from './currentHostTarget'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, isKCoderGatewayPage, type GatewayServer } from '@/kcoder/gatewayRpc'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { useRetainedPageVisible } from '@/components/layout/retainedPageState'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'

export interface RuntimeSettingsTargetsState {
  targets: GatewayServer[]
  currentRuntimeTarget: GatewayServer | null
  selectedTarget: GatewayServer | null
  selectedServerId: string
  selectTarget: (serverId: string) => void
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Loads the Gateway's configured runtime targets for settings pages.
 * The local host is the default; explicit selections survive ordinary refreshes.
 * The current conversation target is displayed separately.
 */
export function useRuntimeSettingsTargets({ enabled = true }: { enabled?: boolean } = {}): RuntimeSettingsTargetsState {
  const visible = useRetainedPageVisible() && enabled
  const { state } = useWorkbench()
  const [targets, setTargets] = useState<GatewayServer[]>([])
  const [selectedServerId, setSelectedServerId] = useState('')
  const [loading, setLoading] = useState(isKCoderGatewayPage)
  const [error, setError] = useState<string | null>(() => isKCoderGatewayPage() ? null : 'unsupported')
  const readController = useRef<AbortController | null>(null)

  const loadTargets = useCallback(async ({ invalidate = false, defer = false } = {}) => {
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    if (invalidate) {
      setTargets([])
    }
    setLoading(true)
    setError(null)
    if (defer) return
    try {
      const nextTargets = await fetchGatewayServers(fetch, { signal: controller.signal })
      if (controller.signal.aborted) return
      setTargets(nextTargets)
      setSelectedServerId(current => {
        if (nextTargets.some(target => target.id === current)) return current
        return currentHostServer(nextTargets)?.id ?? ''
      })
    } catch {
      if (controller.signal.aborted) return
      setTargets([])
      setSelectedServerId('')
      setError('load_failed')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  const readPendingTargets = useStableEvent(() => {
    if (loading) void loadTargets()
  })
  useEffect(() => {
    if (!isKCoderGatewayPage()) return
    let active = true
    queueMicrotask(() => { if (active && visible) readPendingTargets() })
    const serversChanged = () => {
      void loadTargets({ invalidate: true, defer: true })
      const request = readController.current
      // Let every configuration listener retire the previous HTTP scope first.
      queueMicrotask(() => {
        if (active && visible && readController.current === request) void loadTargets()
      })
    }
    const stopAccount = listenAccountContextChanges(serversChanged)
    window.addEventListener('kcoder:servers-changed', serversChanged)
    return () => {
      active = false
      readController.current?.abort()
      readController.current = null
      stopAccount()
      window.removeEventListener('kcoder:servers-changed', serversChanged)
    }
  }, [loadTargets, readPendingTargets, visible])

  const currentRuntimeDeviceId = workbenchModelTarget(state).deviceId?.trim() ?? ''
  const currentRuntimeTarget = targets.find(target => target.id === currentRuntimeDeviceId) ?? null
  const selectedTarget = targets.find(target => target.id === selectedServerId) ?? null

  const selectTarget = useCallback(
    (serverId: string) => {
      if (serverId === '' || targets.some(target => target.id === serverId)) {
        setSelectedServerId(serverId)
      }
    },
    [targets]
  )

  return {
    targets,
    currentRuntimeTarget,
    selectedTarget,
    selectedServerId,
    selectTarget,
    loading,
    error,
    refresh: () => loadTargets({ invalidate: true }),
  }
}
