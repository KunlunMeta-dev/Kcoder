import { useCallback, useEffect, useRef } from 'react'

/** Scope manual reads to the mounted, visible canvas. This does not cancel a run. */
export function useWorkflowReadCancellation(active = true) {
  const current = useRef<AbortController | null>(null)
  const cancel = useCallback(() => {
    current.current?.abort()
    current.current = null
  }, [])
  const begin = useCallback(() => {
    cancel()
    const controller = new AbortController()
    current.current = controller
    if (!active || document.visibilityState === 'hidden') controller.abort()
    return controller.signal
  }, [active, cancel])
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (!active) cancel()
    return () => {
      cancel()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, cancel])
  return { begin, cancel }
}
