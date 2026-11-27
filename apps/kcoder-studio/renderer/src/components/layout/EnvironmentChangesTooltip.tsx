import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { calculateFloatingMenuLayout } from '@/lib/floating-menu'

/** Escape the environment panel's stacking context and keep the explanation in view. */
export function EnvironmentChangesTooltip({ id, description, children }: {
  id: string
  description: string
  children: ReactNode
}) {
  const [visible, setVisible] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const trigger = anchor.current
    const content = tooltip.current
    if (!visible || !trigger || !content) return
    const update = () => {
      const margin = 16
      content.style.width = `${Math.min(256, Math.max(0, window.innerWidth - margin * 2))}px`
      const rect = trigger.getBoundingClientRect()
      const layout = calculateFloatingMenuLayout({
        triggerRect: rect,
        visibleBounds: { top: margin, bottom: window.innerHeight - margin },
        preferredPlacement: 'above',
        maxHeight: content.scrollHeight + 2,
      })
      content.style.maxHeight = `${layout.maxHeight}px`
      const width = content.getBoundingClientRect().width
      const height = content.getBoundingClientRect().height
      content.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`
      content.style.top = `${Math.max(margin, layout.placement === 'above' ? rect.top - height - 8 : rect.bottom + 8)}px`
      content.style.visibility = 'visible'
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(trigger)
    observer?.observe(content)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
      content.style.visibility = ''
    }
  }, [visible, description])
  return (
    <div ref={anchor}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => {
        if (!anchor.current?.contains(document.activeElement)) setVisible(false)
      }}
      onFocus={() => setVisible(true)}
      onBlur={() => {
        if (!anchor.current?.matches(':hover')) setVisible(false)
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && visible) {
          event.stopPropagation()
          setVisible(false)
        }
      }}>
      {children}
      {createPortal(
        <span ref={tooltip} id={id} role="tooltip" hidden={!visible}
          data-testid="environment-changes-description"
          className="pointer-events-none invisible fixed z-system w-64 overflow-y-auto whitespace-pre-line break-words rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed text-text-primary shadow-lg">
          {description}
        </span>, document.body
      )}
    </div>
  )
}
