import { currentHostServer } from './currentHostTarget'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, isKCoderGatewayPage, type GatewayServer } from '@/kcoder/gatewayRpc'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'

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
export function useRuntimeSettingsTargets(): RuntimeSettingsTargetsState {
  const { state } = useWorkbench()
  const [targets, setTargets] = useState<GatewayServer[]>([])
  const [selectedServerId, setSelectedServerId] = useState('')
  const [loading, setLoading] = useState(isKCoderGatewayPage)
  const [error, setError] = useState<string | null>(() => isKCoderGatewayPage() ? null : 'unsupported')
  const generation = useRef(0)

  const loadTargets = useCallback(async (invalidate = false) => {
    const requestGeneration = ++generation.current
    if (invalidate) {
      setTargets([])
    }
    setLoading(true)
    setError(null)
    try {
      const nextTargets = await fetchGatewayServers()
      if (generation.current !== requestGeneration) return
      setTargets(nextTargets)
      setSelectedServerId(current => {
        if (nextTargets.some(target => target.id === current)) return current
        return currentHostServer(nextTargets)?.id ?? ''
      })
    } catch {
      if (generation.current !== requestGeneration) return
      setTargets([])
      setSelectedServerId('')
      setError('load_failed')
    } finally {
      if (generation.current === requestGeneration) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isKCoderGatewayPage()) return
    let active = true
    queueMicrotask(() => { if (active) void loadTargets() })
    const serversChanged = () => void loadTargets(true)
    window.addEventListener('kcoder:servers-changed', serversChanged)
    return () => {
      active = false
      generation.current += 1
      window.removeEventListener('kcoder:servers-changed', serversChanged)
    }
  }, [loadTargets])

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
    refresh: () => loadTargets(true),
  }
}
