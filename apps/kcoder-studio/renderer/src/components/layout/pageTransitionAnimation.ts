import { useLayoutEffect, useRef } from 'react'

const active = new WeakMap<HTMLElement, Animation>()
const runningSurfaces = new Set<HTMLElement>()

/** Animate presentation only: never replace a page, reset scroll, or change focus. */
export function animatePageSurface(element: HTMLElement | null | undefined): () => void {
  if (
    !element?.isConnected ||
    typeof element.animate !== 'function' ||
    !element.getClientRects().length
  )
    return () => {}
  const previous = active.get(element)
  if (previous?.playState === 'running') return () => {}
  // Nested surfaces (page header parent, page content, route controller)
  // would multiply their opacities. Keep exactly one running fade per subtree:
  // skip when an ancestor is fading and take over from fading descendants.
  for (const running of runningSurfaces) {
    if (running !== element && running.contains(element)) return () => {}
  }
  for (const running of [...runningSurfaces]) {
    if (running !== element && element.contains(running)) active.get(running)?.cancel()
  }
  const animation = element.animate([{ opacity: 0.45 }, { opacity: 1 }], {
    duration: 180,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  })
  active.set(element, animation)
  runningSurfaces.add(element)
  const forget = () => {
    if (active.get(element) === animation) {
      active.delete(element)
      runningSurfaces.delete(element)
    }
  }
  animation.addEventListener?.('cancel', forget)
  void animation.finished.then(forget, forget)
  return () => {
    if (active.get(element) !== animation) return
    animation.cancel()
    forget()
  }
}
/** Observe a view identity while keeping its container and local state mounted. */
export function usePageSurfaceTransition<T extends HTMLElement>(identity: string) {
  const element = useRef<T>(null)
  useLayoutEffect(() => animatePageSurface(element.current), [identity])
  return element
}
