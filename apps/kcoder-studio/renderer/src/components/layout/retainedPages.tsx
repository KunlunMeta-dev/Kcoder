import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { hideOwnedPortals } from './retainedPagePortals'
import { RetainedPageActive } from './retainedPageState'

/**
 * A retained page: laid out normally while open, hidden and inert otherwise.
 * Its effects stay alive while hidden: pages own clients, transports and
 * authorizations in effects, and disposing them (as Activity does) while
 * keeping state would leave those pages holding closed resources. Periodic
 * work pauses through useRetainedPageActive instead. Dialogs and menus the
 * page portalled into document.body are hidden with it.
 */
export function RetainedPage({ open, children }: { open: boolean; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const owner = container.current
    if (open || !owner) return
    return hideOwnedPortals(owner)
  }, [open])
  return (
    <div
      ref={container}
      data-retained-page={open ? 'active' : 'hidden'}
      style={{ display: open ? 'contents' : 'none' }}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
    >
      <RetainedPageActive.Provider value={open}>{children}</RetainedPageActive.Provider>
    </div>
  )
}
