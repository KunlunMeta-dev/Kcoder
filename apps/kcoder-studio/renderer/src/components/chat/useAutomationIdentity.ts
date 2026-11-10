import { useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import type { AutomationProjectAddress } from '@/kcoder/gatewayAutomationApi'

/** Refresh suspends new actions; unsent drafts clear only when the actual owner changes. */
export function useAutomationIdentity(
  address: AutomationProjectAddress | undefined,
  invalidate: (ownerChanged: boolean) => void
) {
  const deviceId = address?.deviceId
  const workspacePath = address?.workspacePath
  const key = deviceId && workspacePath ? `${deviceId}\0${workspacePath}` : ''
  const previous = useRef<{ key: string; owner: string } | undefined>(undefined)
  const [scope, setScope] = useState<{ key: string; server: GatewayServer } | null>(null)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    let disposed = false
    let generation = 0
    const load = async (forceOwnerChange = false) => {
      const current = ++generation
      const accountCurrent = captureAccountContextRevision()
      invalidate(
        forceOwnerChange || (previous.current !== undefined && previous.current.key !== key)
      )
      setScope(null)
      setFailure('')
      if (!key) return
      try {
        const servers = await fetchGatewayServers()
        if (disposed || current !== generation || !accountCurrent(deviceId!)) return
        const server = servers.find(item => item.id === deviceId)
        if (!server) {
          previous.current = undefined
          invalidate(true)
          return
        }
        const owner = hookTargetScope(server)
        if (previous.current?.key === key && previous.current.owner !== owner) invalidate(true)
        previous.current = { key, owner }
        setScope({ key, server })
      } catch (error) {
        if (!disposed && current === generation)
          setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const changed = (event: Event) => {
      const target = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
      if (!target || target === deviceId) void load()
    }
    const stop = listenAccountContextChanges(target => {
      if (target === deviceId) void load(true)
    })
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      disposed = true
      stop()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [key, deviceId, invalidate])
  const server = scope?.key === key ? scope.server : undefined
  return { server, ready: Boolean(server && (!server.security || server.accountIdentity)), failure }
}
