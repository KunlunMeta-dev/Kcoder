import { useEscapeKey } from '@/hooks/useEscapeKey'
import { Loader2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { type ArchiveConversationsConfirmDialogProps } from './types'

export function ArchiveConversationsConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  submitting,
  testId,
  onClose,
  onConfirm,
}: ArchiveConversationsConfirmDialogProps) {
  useEscapeKey(onClose, open && !submitting)

  if (!open) return null

  return createPortal(
    <div
      data-testid={`${testId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        className="w-full max-w-[460px] rounded-xl border border-border bg-popover p-5 text-text-primary shadow-[0_20px_56px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-start justify-between gap-5">
          <h2 id={`${testId}-title`} className="heading-base tracking-normal">
            {title}
          </h2>
          <button
            type="button"
            data-testid={`${testId}-close-button`}
            onClick={onClose}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={cancelLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel-button`}
            onClick={onClose}
            disabled={submitting}
            className="h-8 min-w-[76px] rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="inline-flex h-8 min-w-[96px] items-center justify-center gap-2 rounded-lg bg-red-500/15 px-4 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
