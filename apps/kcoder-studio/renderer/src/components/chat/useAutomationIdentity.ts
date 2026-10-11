import { useEffect, useState } from 'react'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import type { AutomationProjectAddress } from '@/kcoder/gatewayAutomationApi'

/** Server metadata is a display boundary; the Gateway remains the identity authority. */
export function useAutomationIdentity(
  address: AutomationProjectAddress | undefined,
  invalidate: () => void
) {
  const deviceId = address?.deviceId
  const workspacePath = address?.workspacePath
  const key = deviceId && workspacePath ? `${deviceId}\0${workspacePath}` : ''
  const [scope, setScope] = useState<{ key: string; server: GatewayServer } | null>(null)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    let disposed = false
    let generation = 0
    const load = async () => {
      const current = ++generation
      invalidate()
      setScope(null)
      setFailure('')
      if (!key) return
      try {
        const servers = await fetchGatewayServers()
        if (disposed || current !== generation) return
        const server = servers.find(item => item.id === deviceId)
        if (server) setScope({ key, server })
      } catch (error) {
        if (!disposed && current === generation)
          setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const changed = () => void load()
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      disposed = true
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [key, deviceId, invalidate])
  const server = scope?.key === key ? scope?.server : undefined
  return {
    server,
    ready: Boolean(server && (!server.security || server.accountIdentity)),
    failure,
  }
}
