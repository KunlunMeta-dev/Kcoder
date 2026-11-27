import { useCallback, useEffect, useRef, useState } from 'react'

/** Runtime events update the workbench; foreground/manual reads reconcile reconnect gaps. */
export function useExpertConversationRefresh(read: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [successfulRead, setSuccessfulRead] = useState<typeof read | null>(null)
  const owner = useRef<{ active: boolean; pending: boolean } | null>(null)
  const refresh = useCallback(async () => {
    const lifetime = owner.current
    if (!lifetime?.active || lifetime.pending) return
    lifetime.pending = true
    setBusy(true)
    try {
      await read()
      if (lifetime.active) {
        setError(false)
        setSuccessfulRead(() => read)
      }
    } catch {
      if (lifetime.active) setError(true)
    } finally {
      lifetime.pending = false
      if (lifetime.active) setBusy(false)
    }
  }, [read])
  useEffect(() => {
    const lifetime = { active: true, pending: false }
    owner.current = lifetime
    const visibleRead = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    visibleRead()
    window.addEventListener('focus', visibleRead)
    document.addEventListener('visibilitychange', visibleRead)
    return () => {
      lifetime.active = false
      window.removeEventListener('focus', visibleRead)
      document.removeEventListener('visibilitychange', visibleRead)
    }
  }, [refresh])
  return { busy, error, hasSuccessfulRead: successfulRead === read, refresh }
}
