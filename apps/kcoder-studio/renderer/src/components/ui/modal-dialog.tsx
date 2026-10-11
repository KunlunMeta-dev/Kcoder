import { X } from 'lucide-react'
import { Button } from './button'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { cn } from '@/lib/utils'

const controlsSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

function availableControl(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (
      parent.tagName === 'DETAILS' &&
      !parent.hasAttribute('open') &&
      !parent.querySelector(':scope > summary')?.contains(element)
    )
      return false
  }
  return true
}

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
}: {
  title: string
  testId: string
  pending?: boolean
  wide?: boolean
  onClose: () => void
  closeLabel?: string
  children: ReactNode
  className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  useEscapeKey(onClose, !pending)
  useEffect(() => {
    Array.from(root.current?.querySelectorAll<HTMLElement>(controlsSelector) ?? [])
      .find(availableControl)
      ?.focus()
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [returnFocus])
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/15 p-4">
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        aria-busy={pending}
        data-testid={testId}
        tabIndex={-1}
        className={cn(
          `max-h-[calc(100dvh-2rem)] w-full ${wide ? 'flex max-w-4xl flex-col' : 'max-w-[520px]'} overflow-y-auto rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg`,
          className
        )}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const controls = Array.from(
            root.current?.querySelectorAll<HTMLElement>(controlsSelector) ?? []
          ).filter(availableControl)
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
