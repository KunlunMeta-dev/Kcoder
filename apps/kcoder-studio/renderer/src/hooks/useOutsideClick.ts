import { useEffect, type RefObject } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'

export function useOutsideClick(
  ref: RefObject<HTMLElement | null> | readonly RefObject<HTMLElement | null>[],
  active: boolean,
  onOutsideClick: () => void,
  capture = false,
) {
  const pageActive = useRetainedPageActive()
  useEffect(() => {
    if (!active || !pageActive) return
    const roots = 'current' in ref ? [ref] : ref

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      if (!(target instanceof Node) || roots.some(root => root.current?.contains(target))) {
        return
      }

      onOutsideClick()
    }

    document.addEventListener('pointerdown', handlePointerDown, capture)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, capture)
    }
  }, [active, capture, onOutsideClick, pageActive, ref])
}
