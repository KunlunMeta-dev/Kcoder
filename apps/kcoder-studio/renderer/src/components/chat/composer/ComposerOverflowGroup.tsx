import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import {
  calculateFloatingMenuHorizontalLayout,
  getFloatingMenuVisibleBounds,
  observeFloatingMenuLayout,
} from '@/lib/floating-menu'

const OVERFLOW_MENU_WIDTH = 256

/** Native popovers keep the same controls mounted while escaping pane clipping. */
export function ComposerOverflowGroup({
  children,
  folded,
  id,
  label,
  triggerRef,
  onOpenChange,
}: {
  children: ReactNode
  folded: boolean
  id: string
  label: string
  triggerRef: RefObject<HTMLButtonElement | null>
  onOpenChange: (open: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const layoutCleanup = useRef<(() => void) | null>(null)
  const pageActive = useRetainedPageActive()
  useEffect(() => {
    if (!pageActive && ref.current?.matches(':popover-open')) ref.current.hidePopover()
  }, [pageActive])
  useEffect(() => () => layoutCleanup.current?.(), [])

  const updatePosition = (panel: HTMLDivElement) => {
    const trigger = triggerRef.current
    const rect = trigger?.getBoundingClientRect()
    if (!trigger || !rect) return
    const layout = calculateFloatingMenuHorizontalLayout({
      anchorRect: rect,
      containerLeft: 0,
      visibleBounds: getFloatingMenuVisibleBounds(trigger, 8),
      preferredWidth: OVERFLOW_MENU_WIDTH,
    })
    panel.style.left = `${layout.left}px`
    panel.style.width = `${layout.width}px`
    panel.style.bottom = `${window.innerHeight - rect.top + 8}px`
    panel.style.maxHeight = `${Math.max(0, rect.top - 16)}px`
  }

  return (
    <div
      ref={ref}
      id={id}
      data-composer-overflow-group
      popover={folded ? 'auto' : undefined}
      role={folded ? 'dialog' : undefined}
      aria-label={folded ? label : undefined}
      onClick={event => {
        if (
          event.target instanceof Element &&
          event.currentTarget.contains(event.target) &&
          event.target.closest('[aria-haspopup="dialog"]') &&
          event.currentTarget.matches(':popover-open')
        ) {
          event.currentTarget.hidePopover()
        }
      }}
      onBeforeToggle={event => {
        if (event.target !== event.currentTarget || event.newState !== 'open') return
        updatePosition(event.currentTarget)
      }}
      onToggle={event => {
        if (event.target !== event.currentTarget) return
        const isOpen = event.newState === 'open'
        onOpenChange(isOpen)
        layoutCleanup.current?.()
        layoutCleanup.current = null
        if (isOpen) {
          const panel = event.currentTarget
          const update = () => updatePosition(panel)
          layoutCleanup.current = observeFloatingMenuLayout(triggerRef.current, update)
        }
      }}
    >
      {children}
    </div>
  )
}
