import { useEffect } from 'react'
import { animatePageSurface } from './pageTransitionAnimation'

const surfaceSelector =
  '[data-studio-page-content], .studio-page-header, [data-testid="desktop-workbench-main"]'

/** Route and tab transitions keep resident conversations and native resources mounted. */
export function PageTransitionController() {
  useEffect(() => {
    let frame = 0
    let owned: Array<() => void> = []
    const schedule = (tab?: HTMLElement) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        owned.forEach(cancel => cancel())
        let candidates: HTMLElement[]
        const selected =
          tab
            ?.closest('[role="tablist"]')
            ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? tab
        const controlled = selected?.getAttribute('aria-controls')
        const panel = controlled ? document.getElementById(controlled) : null
        const local =
          panel ?? selected?.closest<HTMLElement>('[data-studio-page-content], .studio-page-gutter')
        if (local) candidates = [local]
        else
          candidates = Array.from(document.querySelectorAll<HTMLElement>(surfaceSelector)).map(
            element =>
              element.classList.contains('studio-page-header') ? element.parentElement! : element
          )
        const visible = [...new Set(candidates)].filter(
          element =>
            element.isConnected &&
            element.getClientRects().length > 0 &&
            !element.closest('[hidden], [aria-hidden="true"]')
        )
        owned = visible
          .filter(
            element => !visible.some(parent => parent !== element && parent.contains(element))
          )
          .map(animatePageSurface)
      })
    }
    const route = () => schedule()
    const tab = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)
      )
        return
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null
      // Document listeners run before React re-renders the tablist, so the
      // attribute still describes the previous selection: re-selecting the
      // current tab is not a transition.
      const activates =
        !(event instanceof KeyboardEvent) || event.key === 'Enter' || event.key === ' '
      if (
        target &&
        !target.hasAttribute('disabled') &&
        !(activates && target.getAttribute('aria-selected') === 'true')
      )
        schedule(target)
    }
    window.addEventListener('popstate', route)
    document.addEventListener('click', tab)
    document.addEventListener('keydown', tab)
    return () => {
      window.removeEventListener('popstate', route)
      document.removeEventListener('click', tab)
      document.removeEventListener('keydown', tab)
      cancelAnimationFrame(frame)
      owned.forEach(cancel => cancel())
    }
  }, [])
  return null
}
