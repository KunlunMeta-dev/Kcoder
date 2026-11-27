import { X } from 'lucide-react'
import { Button } from './button'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { cn } from '@/lib/utils'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import { isElementVisibleForFocus } from '@/lib/focus'

const controlsSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Shared blocking editor shell: bounded scrolling, keyboard containment and return focus. */
export function ModalDialog({
  title,
  testId,
  pending = false,
  wide = false,
  onClose,
  closeLabel,
  children,
  className,
  hidden = false,
}: {
  title: string
  testId: string
  pending?: boolean
  wide?: boolean
  onClose: () => void
  closeLabel?: string
  children: ReactNode
  className?: string
  hidden?: boolean
}) {
  const pageActive = useRetainedPageActive()
  const root = useRef<HTMLDivElement>(null)
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  useEscapeKey(onClose, !pending && !hidden)
  useEffect(() => {
    if (!pageActive || hidden) return
    Array.from(root.current?.querySelectorAll<HTMLElement>(controlsSelector) ?? [])
      .find(isElementVisibleForFocus)
      ?.focus()
    return () => {
      if (returnFocus?.isConnected && isElementVisibleForFocus(returnFocus))
        returnFocus.focus({ preventScroll: true })
    }
  }, [pageActive, returnFocus, hidden])
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/15 p-4"
      hidden={hidden} inert={hidden || undefined} aria-hidden={hidden || undefined}
      style={hidden ? { display: 'none' } : undefined}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        aria-busy={pending}
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          `max-h-[calc(100dvh-2rem)] w-full ${wide ? 'flex max-w-4xl flex-col' : 'max-w-[520px]'} overflow-y-auto rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg [scrollbar-gutter:stable]`,
          className
        )}
        onKeyDown={event => {
          if (hidden) return
          if (event.key !== 'Tab') return
          const controls = Array.from(
            root.current?.querySelectorAll<HTMLElement>(controlsSelector) ?? []
          ).filter(isElementVisibleForFocus)
          if (!controls.length) {
            event.preventDefault()
            root.current?.focus()
            return
          }
          const first = controls[0],
            last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 bg-popover">
          <h2 id={`${testId}-title`} className="heading-sm min-w-0 break-words">
            {title}
          </h2>
          {closeLabel && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 max-md:min-h-11 max-md:min-w-11"
              disabled={pending}
              aria-label={closeLabel}
              title={closeLabel}
              data-testid={`${testId}-close`}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}
