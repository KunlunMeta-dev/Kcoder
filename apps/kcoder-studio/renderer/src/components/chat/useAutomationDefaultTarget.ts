import { useEffect, useState } from 'react'
import { currentHostServer } from '@/features/runtime-target/currentHostTarget'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'

type LocalHost = { id: string; workspacePath?: string }

/** Resolve only the Gateway's local host, never an arbitrary remote target. */
export function useAutomationDefaultTarget(
  currentHostId: string | undefined,
  needed: boolean
): LocalHost | null {
  const [host, setHost] = useState<LocalHost | null>(null)
  useEffect(() => {
    if (!needed) return
    let active = true
    let generation = 0
    const load = async () => {
      const request = ++generation
      const accountCurrent = captureAccountContextRevision()
      try {
        const servers = await fetchGatewayServers()
        if (!active || request !== generation) return
        const server = currentHostId
          ? servers.find(item => item.id === currentHostId && item.transport === 'local')
          : currentHostServer(servers)
        if (!server || !accountCurrent(server.id)) {
          setHost(null)
          return
        }
        setHost({
          id: server.id,
          workspacePath: server.workspacePath?.trim() ? server.workspacePath : undefined,
        })
      } catch {
        if (active && request === generation) setHost(null)
      }
    }
    void load()
    const changed = () => {
      void load()
    }
    const stopAccount = listenAccountContextChanges(changed)
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      active = false
      generation++
      stopAccount()
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [currentHostId, needed])
  if (!needed || (currentHostId && host?.id !== currentHostId)) return null
  return host
}
