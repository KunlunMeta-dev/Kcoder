import { safeErrorDiagnostic } from '@/lib/error-diagnostics'
import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { isGatewayRuntime } from '@/lib/runtime-environment'
import { useDesktopTrayAvailability } from '@/kcoder/useDesktopTrayAvailability'
import { updateAppPreferences } from '@/host/appPreferences'
import { closeMainWindowToTray, installRuntimeTaskCloseGuard } from '@/host/runtimeTaskCloseGuard'
import { useRuntimeTaskLifecycleStoreSnapshot } from './runtimeTaskLifecycle'

export function RuntimeTaskCloseGuard() {
  const { t } = useTranslation('common')
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  const trayAvailability = useDesktopTrayAvailability()
  const pendingClose = useRef(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [hideUnconfirmed, setHideUnconfirmed] = useState(false)

  useEffect(() => {
    if (!isGatewayRuntime() || trayAvailability !== 'available') return undefined

    let unlisten: (() => void) | undefined
    let cancelled = false

    void installRuntimeTaskCloseGuard(() => {
      if (cancelled || lifecycle.runningTaskKeys.size === 0 || pendingClose.current) return
      setClosing(false)
      setHideUnconfirmed(false)
      setCloseDialogOpen(true)
    })
      .then(nextUnlisten => {
        if (cancelled) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to install runtime task close guard:', safeErrorDiagnostic(error))
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [lifecycle.runningTaskKeys.size, trayAvailability])

  return (
    <RuntimeTaskCloseConfirmDialog
      open={closeDialogOpen && trayAvailability === 'available'}
      closing={closing}
      errorMessage={hideUnconfirmed ? t('workbench.close_to_tray_unconfirmed') : undefined}
      title={t('workbench.close_to_tray_hint_title')}
      description={t('workbench.close_to_tray_hint_description')}
      cancelLabel={t('workbench.close_to_tray_hint_keep_open')}
      confirmLabel={t('workbench.close_to_tray_hint_action')}
      onCancel={() => {
        if (closing) return
        setCloseDialogOpen(false)
      }}
      onConfirm={async () => {
        if (pendingClose.current) return
        pendingClose.current = true
        setClosing(true)
        try {
          await closeMainWindowToTray()
          flushSync(() => {
            setCloseDialogOpen(false)
            setClosing(false)
          })
          try { await updateAppPreferences({ closeToTrayHintSeen: true }) }
          catch (error) { console.error('Failed to save acknowledged close-to-tray hint:', safeErrorDiagnostic(error)) }
        } catch (error) {
          console.error('Failed to hide window after close-to-tray hint confirmation:', safeErrorDiagnostic(error))
          setHideUnconfirmed(true)
          setCloseDialogOpen(true)
          setClosing(false)
        } finally {
          pendingClose.current = false
        }
      }}
    />
  )
}

interface RuntimeTaskCloseConfirmDialogProps {
  open: boolean
  closing: boolean
  errorMessage?: string
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}

function RuntimeTaskCloseConfirmDialog({
  open,
  closing,
  errorMessage,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: RuntimeTaskCloseConfirmDialogProps) {
  useEscapeKey(() => {
    if (!closing) onCancel()
  }, open && !closing)

  if (!open) return null

  return createPortal(
    <div
      data-testid="runtime-task-close-confirm-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-task-close-confirm-title"
        className="w-full max-w-[420px] rounded-lg border border-border bg-base p-5 shadow-2xl"
      >
        <h2
          id="runtime-task-close-confirm-title"
          className="text-base font-semibold text-text-primary"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm leading-[18px] text-text-secondary">{description}</p>
        {errorMessage && <p role="alert" className="mt-2 text-sm text-destructive">{errorMessage}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="runtime-task-close-cancel-button"
            disabled={closing}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="runtime-task-close-confirm-button"
            disabled={closing}
            onClick={() => {
              void onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
