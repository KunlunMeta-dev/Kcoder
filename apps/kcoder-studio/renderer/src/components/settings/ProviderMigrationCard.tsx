import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { MigrationDialog } from './MigrationDialog'

export function ProviderMigrationCard({
  target,
  onRefresh,
  disabled = false,
}: {
  target: GatewayServer
  onRefresh: () => Promise<void>
  disabled?: boolean
}) {
  const { t } = useTranslation('common')
  const [dialogOpen, setDialogOpen] = useState(false)
  return (
    <>
      <section
        className="studio-card-spacing space-y-3 rounded-2xl border border-border/60 bg-surface/50"
        data-testid="provider-migration-card"
      >
        <h2 className="text-base font-semibold">{t('providerSettings.migrationTitle')}</h2>
        <p className="text-sm text-text-secondary">{t('providerSettings.migrationDescription')}</p>
        <Button
          size="sm"
          data-testid="provider-migration-open"
          disabled={disabled}
          onClick={() => {
            setDialogOpen(true)
          }}
        >
          {t('providerSettings.migrationAction')}
        </Button>
      </section>
      {dialogOpen && (
        <MigrationDialog
          target={target}
          workspacePath={target.workspacePath}
          onClose={() => {
            setDialogOpen(false)
            void onRefresh()
          }}
        />
      )}
    </>
  )
}
