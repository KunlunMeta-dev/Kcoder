import { useEffect, useState, type ComponentType } from 'react'
import { Loader2 } from 'lucide-react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from '@/kcoder/gatewayRpc'

export interface MigrationDialogProps {
  onClose: () => void
  target?: GatewayServer
  workspacePath?: string
  initialMode?: 'batch' | 'memory'
  initialJobId?: string
}

export function MigrationDialog({ onClose, ...props }: MigrationDialogProps) {
  const { t } = useTranslation('migration')
  const [Content, setContent] = useState<ComponentType<Omit<MigrationDialogProps, 'onClose'>> | 'failed' | null>(null)
  useEffect(() => {
    let active = true
    import('./MigrationDialogContent').then(module => {
      if (active) setContent(() => module.MigrationDialogContent)
    }).catch(() => {
      if (active) setContent('failed')
    })
    return () => { active = false }
  }, [])
  return (
    <ModalDialog title={t('title')} testId="migration-dialog" wide
      className="max-md:[&_button]:min-h-11 max-md:[&_select]:min-h-11"
      onClose={onClose} closeLabel={t('close')}>
      {Content === 'failed' ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{t('dialog_load_failed')}</p>
      ) : Content ? <Content {...props} /> : (
        <div role="status" aria-busy="true" className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          {t('dialog_loading')}
        </div>
      )}
    </ModalDialog>
  )
}
