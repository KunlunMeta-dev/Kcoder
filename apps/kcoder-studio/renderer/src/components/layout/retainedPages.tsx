import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { hideOwnedPortals } from './retainedPagePortals'
import { RetainedPageActive, useRetainedPageActive } from './retainedPageState'

/**
 * A retained page: laid out normally while open, hidden and inert otherwise.
 * Its effects stay alive while hidden: pages own clients, transports and
 * authorizations in effects, and disposing them (as Activity does) while
 * keeping state would leave those pages holding closed resources. Periodic
 * work pauses through useRetainedPageActive instead. Dialogs and menus the
 * page portalled into document.body are hidden with it.
 */
export function RetainedPage({ open, children }: { open: boolean; children: ReactNode }) {
  const parentActive = useRetainedPageActive()
  const active = parentActive && open
  const container = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const owner = container.current
    // The outermost hidden page owns portal hiding for its whole subtree.
    if (!parentActive || open || !owner) return
    return hideOwnedPortals(owner)
  }, [open, parentActive])
  return (
    <div
      ref={container}
      data-retained-page={active ? 'active' : 'hidden'}
      style={{ display: active ? 'contents' : 'none' }}
      aria-hidden={!active || undefined}
      inert={!active || undefined}
    >
      <RetainedPageActive.Provider value={active}>{children}</RetainedPageActive.Provider>
    </div>
  )
}
