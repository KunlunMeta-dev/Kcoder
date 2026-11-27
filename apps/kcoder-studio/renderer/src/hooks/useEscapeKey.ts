import { useEffect } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'

export function useEscapeKey(onEscape: () => void, enabled = true) {
  const pageActive = useRetainedPageActive()
  useEffect(() => {
    if (!enabled || !pageActive) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onEscape()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [enabled, onEscape, pageActive])
}
