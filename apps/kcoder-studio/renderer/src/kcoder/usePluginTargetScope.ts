import { useLayoutEffect, useMemo, useState } from 'react'
import { listenAccountContextChanges } from './accountContextEvents'
import { fetchGatewayServers } from './gatewayRpc'
import { hookTargetScope } from './gatewayHookConfiguration'

class PluginScopeLifetime {
  private active = true
  readonly key: string
  constructor(key: string) {
    this.key = key
  }
  isCurrent = () => this.active
  activate() {
    this.active = true
  }
  invalidate() {
    this.active = false
  }
}

/** A UI lifetime, not an authorization token. Gateway still enforces account ownership. */
export function usePluginTargetScope(deviceId?: string, workspacePath?: string) {
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([deviceId ?? null, workspacePath ?? null, revision])
  const lifetime = useMemo(() => new PluginScopeLifetime(key), [key])
  useLayoutEffect(() => {
    lifetime.activate()
    let disposed = false
    let fingerprint: string | undefined
    let readRevision = 0
    const invalidate = () => {
      lifetime.invalidate()
      setRevision(value => value + 1)
    }
    const readConfiguration = async (changed = false) => {
      const attempt = ++readRevision
      try {
        const servers = await fetchGatewayServers()
        if (disposed || attempt !== readRevision) return
        const target = deviceId ? servers.find(item => item.id === deviceId) : servers[0]
        const next = target ? hookTargetScope(target) : ''
        if (changed && (fingerprint === undefined || next !== fingerprint)) invalidate()
        fingerprint = next
      } catch {
        /* RPC scope checks still reject an unavailable or changed target. */
      }
    }
    void readConfiguration()
    const changed = (event: Event) => {
      const targetId = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
      if (targetId && deviceId && targetId !== deviceId) return
      void readConfiguration(true)
    }
    const stopAccount = listenAccountContextChanges(targetId => {
      if (!deviceId || deviceId === targetId) invalidate()
    })
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      disposed = true
      lifetime.invalidate()
      stopAccount()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [lifetime, deviceId])
  return { key, isCurrent: lifetime.isCurrent }
}
