import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { Button } from '@/components/ui/button'

interface RuntimeTargetConfirmDialogProps {
  title: string
  description: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  testId: string
  pending?: boolean
  destructive?: boolean
  children?: ReactNode
  confirmDisabled?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}

export function RuntimeTargetConfirmDialog({
  title,
  description,
  cancelLabel,
  closeLabel,
  confirmLabel,
  testId,
  pending = false,
  destructive = false,
  children,
  confirmDisabled = false,
  error,
  onCancel,
  onConfirm,
}: RuntimeTargetConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEscapeKey(onCancel, !pending)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (!controls?.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/25 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        aria-describedby={`${testId}-description`}
        data-testid={testId}
        onKeyDown={trapFocus}
        className="w-full max-w-[420px] rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id={`${testId}-title`} className="heading-sm text-text-primary">
              {title}
            </h2>
            <p id={`${testId}-description`} className="mt-2 text-sm text-text-secondary">
              {description}
            </p>
            {error && (
              <p role="alert" className="mt-2 text-sm text-red-500">
                {error}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={closeLabel}
            disabled={pending}
            onClick={onCancel}
            className="h-8 w-8 shrink-0 focus-visible:ring-blue-500 max-md:h-11 max-md:w-11"
            data-testid={`${testId}-close`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children && <div className="mt-4 space-y-3">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={onCancel}
            className="focus-visible:ring-blue-500 max-md:h-11"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'primary'}
            size="sm"
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
            className="min-w-24 focus-visible:ring-blue-500 max-md:h-11"
            data-testid={`${testId}-confirm`}
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
