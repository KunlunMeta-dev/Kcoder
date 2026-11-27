import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { startGatewayKcoderTui } from '@/kcoder/gatewayServiceBridge'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import type { NativeSlashLaunch, StartedTerminal } from './NativeSlashTerminalDialog'

async function closeTerminal(started: StartedTerminal) {
  const client = started.clientFactory(started.session.session_id)
  try {
    await client.close()
  } finally {
    client.dispose()
  }
}

export function useNativeSlashTerminal(deviceId: string | undefined, workspace: string | undefined, ownerKey: string) {
  const scope = usePluginTargetScope(deviceId, workspace)
  const owner = JSON.stringify([scope.key, deviceId, workspace, ownerKey])
  const [launch, setLaunch] = useState<NativeSlashLaunch | null>(null)
  const current = useRef<{ owner: string; started?: StartedTerminal } | null>(null)

  const close = useCallback(() => {
    const started = current.current?.started
    current.current = null
    setLaunch(null)
    if (started) void closeTerminal(started).catch(() => undefined)
  }, [])

  useLayoutEffect(() => () => {
    const previous = current.current
    if (previous?.owner !== owner) return
    current.current = null
    if (previous.started) void closeTerminal(previous.started).catch(() => undefined)
  }, [owner])

  const run = useCallback((command: string, threadId?: string) => {
    if (!deviceId || !workspace || !scope.isCurrent() || current.current) {
      throw new Error('TERMINAL_KCODER_TUI_OWNER_UNAVAILABLE')
    }
    const name = command.split(/\s+/, 1)[0]
    const pending: { owner: string; started?: StartedTerminal } = { owner }
    const isCurrent = () => current.current === pending && scope.isCurrent()
    current.current = pending
    setLaunch({ owner, name })
    void startGatewayKcoderTui(deviceId, workspace, {
      request: { command, ...(threadId ? { thread_id: threadId } : {}) },
      isCurrent,
    }).then(started => {
      if (!isCurrent()) {
        void closeTerminal(started).catch(() => undefined)
        return
      }
      pending.started = started
      setLaunch({ owner, name, started })
    }, (error: unknown) => {
      if (!isCurrent()) return
      const code = error instanceof Error ? error.message : ''
      const kind = code === 'TERMINAL_KCODER_TUI_UNSUPPORTED' ? 'unsupported' :
        code === 'TERMINAL_KCODER_TUI_SESSION_BUSY' ? 'busy' : 'failed'
      setLaunch({ owner, name, error: kind })
    })
  }, [deviceId, owner, scope, workspace])

  const markExited = useCallback((sessionId: string) => {
    setLaunch(previous => previous?.started?.session.session_id === sessionId
      ? { ...previous, exited: true } : previous)
  }, [])
  return { run, launch: launch?.owner === owner ? launch : null, close, markExited }
}
