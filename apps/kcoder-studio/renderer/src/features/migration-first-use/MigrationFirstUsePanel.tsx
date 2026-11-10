import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { MigrationDialog } from '@/components/settings/MigrationDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { ProviderSettings } from '@/kcoder/providerSettings'
import { navigateTo } from '@/lib/navigation'
import { firstUseSkipped, migrationFirstUseStatus, skipFirstUse } from './migrationFirstUseState'

export function MigrationFirstUsePanel({ target, workspacePath, settings, onRefresh, manual = false }: {
  target: GatewayServer; workspacePath?: string; settings: ProviderSettings | null; onRefresh: () => Promise<void>; manual?: boolean
}) {
  const { t } = useTranslation('migration')
  const scope = migrationSourceRecoveryScope({ ...target, ...(workspacePath === undefined ? {} : { workspacePath }) })
  const current = usePluginTargetScope(target.id, workspacePath ?? target.workspacePath)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ scope: string; owner: string } | null>(null)
  const status = migrationFirstUseStatus(settings)
  const hidden = dismissed === scope || firstUseSkipped(scope) || status === 'unknown' || status === 'configured' || manual && status === 'incomplete'
  const open = dialog?.scope === scope && dialog.owner === current.key && current.isCurrent()
  return <>
    {!hidden && <section data-testid="migration-first-use" className="studio-card-spacing space-y-2 rounded-lg border border-border bg-surface text-sm">
      <p className="font-medium">{t(status === 'unconfigured' ? 'firstUse.title' : 'firstUse.incompleteTitle')}</p>
      <p className="leading-6 text-text-secondary">{t(status === 'unconfigured' ? 'firstUse.description' : 'firstUse.incompleteDescription')}</p>
      <div className="flex flex-wrap gap-2">
        {status === 'unconfigured' && <Button size="sm" data-testid="migration-first-use-import" onClick={() => { if (current.isCurrent()) setDialog({ scope, owner: current.key }) }}>{t('firstUse.import')}</Button>}
        {!manual && <Button size="sm" variant="outline" data-testid="migration-first-use-manual" onClick={() => { if (current.isCurrent()) navigateTo('/settings/model-settings') }}>{t('firstUse.manual')}</Button>}
        <Button size="sm" variant="ghost" data-testid="migration-first-use-skip" onClick={() => { if (current.isCurrent()) { skipFirstUse(scope); setDismissed(scope) } }}>{t('firstUse.skip')}</Button>
      </div>
    </section>}
    {open && <MigrationDialog target={target} workspacePath={workspacePath} onClose={() => {
      setDialog(null)
      if (current.isCurrent()) void onRefresh()
    }}/>}
  </>
}
