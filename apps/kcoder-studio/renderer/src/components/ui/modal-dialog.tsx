import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'

const controlsSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Shared blocking editor shell: bounded scrolling, keyboard containment and return focus. */
export function ModalDialog({
  title,
  testId,
  pending = false,
  onClose,
  children,
}: {
  title: string
  testId: string
  pending?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  useEscapeKey(onClose, !pending)
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(controlsSelector)?.focus()
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
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[520px] overflow-y-auto rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const controls = Array.from(
            root.current?.querySelectorAll<HTMLElement>(controlsSelector) ?? []
          ).filter(element => !element.closest('[hidden], [inert]'))
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
        <h2 id={`${testId}-title`} className="heading-sm">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body
  )
}
