import { computerUseConsent, useComputerUseConsent } from '@/kcoder/computerUseConsent'
import { useRef, useState } from 'react'
import { Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/tauri/localExecutor'

export function ComputerUseSubmit({
  serverId,
  taskId,
  onRevoke,
  prompt,
  disabled,
  onConfirm,
  modelSupportsImages,
}: {
  serverId: string
  taskId?: string
  onRevoke?: () => void
  prompt: string
  disabled: boolean
  onConfirm: () => void
  modelSupportsImages?: boolean
}) {
  const { t } = useTranslation('common')
  const allowed = useComputerUseConsent(serverId, taskId)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<{ canControl: boolean; reason?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [snapshot, setSnapshot] = useState('')
  const checkRevision = useRef(0)
  const close = () => {
    checkRevision.current += 1
    setOpen(false)
    setChecking(false)
  }
  const show = async () => {
    const revision = ++checkRevision.current
    setSnapshot(prompt)
    setOpen(true)
    setStatus(null)
    setError(null)
    setChecking(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        requestLocalExecutor<{ canControl: boolean; reason?: string }>(
          'runtime.computerUse.status',
          { serverId }
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('desktop check timeout')), 10000)
        }),
      ])
      if (checkRevision.current === revision) setStatus(result)
    } catch {
      if (checkRevision.current === revision) setError(t('computerUse.checkFailed'))
    } finally {
      clearTimeout(timer)
      if (checkRevision.current === revision) setChecking(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={allowed ? false : disabled || !prompt.trim()}
        data-testid="computer-use-submit"
        onClick={() => {
          if (allowed && taskId) {
            computerUseConsent.set(serverId, taskId, false)
            onRevoke?.()
          } else void show()
        }}
      >
        <Monitor />
        {t(allowed ? 'computerUse.sessionEnabled' : 'computerUse.title')}
      </Button>
      {open && (
        <ModalDialog title={t('computerUse.title')} testId="computer-use-approval" onClose={close}>
          <p className="my-3 text-sm text-text-secondary">{t('computerUse.approvalDescription')}</p>
          <p className="text-sm">{t('computerUse.target', { target: serverId })}</p>
          {modelSupportsImages === false && (
            <p
              className="mt-2 text-sm text-text-secondary"
              data-testid="computer-use-accessibility-only"
            >
              {t('computerUse.accessibilityOnly')}
            </p>
          )}
          <pre className="my-3 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
            {snapshot}
          </pre>
          {checking && (
            <p role="status" data-testid="computer-use-checking" className="text-sm">
              {t('computerUse.checking')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
          {status && status.canControl !== true && (
            <p role="status" className="text-sm text-text-secondary">
              {t(
                status.reason === 'bundled_component_missing'
                  ? 'computerUse.componentMissing'
                  : status.reason === 'bundled_component_verification_failed'
                    ? 'computerUse.componentInvalid'
                    : status.reason === 'interactive_desktop_required'
                      ? 'computerUse.desktopUnavailable'
                      : status.reason === 'existing_windows_mcp_requires_choice'
                        ? 'computerUse.existingMcp'
                        : 'computerUse.unavailable'
              )}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" data-testid="computer-use-cancel" onClick={close}>
              {t('computerUse.cancel')}
            </Button>
            <Button
              type="button"
              data-testid="computer-use-confirm"
              disabled={checking || disabled || status?.canControl !== true || prompt !== snapshot}
              onClick={() => {
                close()
                onConfirm()
              }}
            >
              {t('computerUse.approveSend')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  )
}
