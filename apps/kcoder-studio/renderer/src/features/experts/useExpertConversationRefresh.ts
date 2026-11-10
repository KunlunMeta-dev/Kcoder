import { useCallback, useEffect, useRef, useState } from 'react'

/** Native channel turns can arrive while no browser owns their execution. */
export function useExpertConversationRefresh(read: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const owner = useRef<{ active: boolean; pending: boolean } | null>(null)
  const refresh = useCallback(async () => {
    const lifetime = owner.current
    if (!lifetime?.active || lifetime.pending) return
    lifetime.pending = true
    setBusy(true)
    try {
      await read()
      if (lifetime.active) setError(false)
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
    const timer = window.setInterval(visibleRead, 10_000)
    window.addEventListener('focus', visibleRead)
    document.addEventListener('visibilitychange', visibleRead)
    return () => {
      lifetime.active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', visibleRead)
      document.removeEventListener('visibilitychange', visibleRead)
    }
  }, [refresh])
  return { busy, error, refresh }
}
