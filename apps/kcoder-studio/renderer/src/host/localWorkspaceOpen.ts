import { desktopHost } from '@/kcoder/desktopHost'
import type { UnlistenFn } from '@/lib/runtime-events'

export type OpenLocalWorkspaceHandler = (
  deviceId: string,
  workspacePath: string,
  label?: string
) => Promise<void>

/** Consume CLI intents only from this primary desktop's authenticated local target. */
export function installLocalWorkspaceOpenListener(
  openLocalWorkspace: OpenLocalWorkspaceHandler,
  onError?: (message: string) => void
): Promise<UnlistenFn> | null {
  const host = desktopHost()
  if (!host?.takeWorkspaceOpenRequests || !host.acknowledgeWorkspaceOpen || !host.onWorkspaceOpen) return null
  const take = host.takeWorkspaceOpenRequests, acknowledge = host.acknowledgeWorkspaceOpen
  let active = true, draining = false, again = false
  const attempted = new Set<string>()
  const current = () => active && desktopHost() === host
  const drain = async () => {
    if (draining) { again = true; return }
    draining = true
    try {
      do {
        again = false
        const requests = await take()
        if (!current()) return
        for (const request of requests) {
          if (!current()) return
          if (!request.id) throw new Error('Invalid desktop workspace-open request')
          if (attempted.has(request.id)) continue
          attempted.add(request.id)
          if (request.error) onError?.(request.error)
          else {
            if (!request.serverId || !request.path) throw new Error('Desktop workspace-open request has no verified target')
            await openLocalWorkspace(request.serverId, request.path, request.label)
          }
          if (!current()) return
          await acknowledge(request.id)
        }
      } while (again && current())
    } catch (error) {
      if (current()) onError?.(error instanceof Error ? error.message : 'Failed to open local workspace from CLI')
    } finally { draining = false }
  }
  // Subscribe before the first read, including requests arriving during startup.
  const off = host.onWorkspaceOpen(() => { void drain() })
  void drain()
  return Promise.resolve(() => { active = false; off() })
}
