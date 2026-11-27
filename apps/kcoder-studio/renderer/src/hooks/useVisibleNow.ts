import { useEffect, useState } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'

/** Local display time only; this hook never samples or controls an execution target. */
export function useVisibleNow(running: boolean, intervalMs: number, untilMs = Infinity): number {
  const pageActive = useRetainedPageActive()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running || !pageActive) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      const now = Date.now()
      setNow(now)
      const remaining = Math.min(intervalMs, untilMs - now)
      if (remaining > 0) timer = setTimeout(tick, remaining)
    }
    const refresh = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (document.visibilityState !== 'visible') return
      tick()
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [running, intervalMs, pageActive, untilMs])
  return now
}
