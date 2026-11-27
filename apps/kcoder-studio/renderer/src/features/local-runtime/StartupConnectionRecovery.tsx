import { Button } from '@/components/ui/button'
import { KCoderServersSettingsPage } from '@/components/settings/KCoderServersSettingsPage'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { useTranslation } from '@/hooks/useTranslation'
import { CurrentInstallationRecoveryAction } from './CurrentInstallationRecoveryAction'

/** Gateway configuration remains usable while its selected Native process is unavailable. */
export default function StartupConnectionRecovery({ sourceId, onClose, onRetry }: { sourceId?: string; onClose(): void; onRetry(): void }) {
  const { t } = useTranslation('localRuntime')
  return <main className="min-h-screen bg-base text-text-primary" data-testid="startup-connection-recovery">
    <MacOSTitleBarDragRegion className="h-12 w-full" />
    <div className="mx-auto max-w-5xl space-y-5 px-6 pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h1 className="heading-base">{t('recovery_title')}</h1>
          <p className="text-sm text-text-secondary">{t('recovery_description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onClose}>{t('recovery_back')}</Button>
          <Button variant="primary" onClick={onRetry} data-testid="startup-recovery-retry">{t('recovery_retry')}</Button>
        </div>
      </div>
      <CurrentInstallationRecoveryAction sourceId={sourceId} onSelected={onRetry} />
      <KCoderServersSettingsPage recovery />
    </div>
  </main>
}
