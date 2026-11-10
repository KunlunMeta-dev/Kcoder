import { useEffect, useRef, useState } from 'react'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import { captureAccountContextRevision, listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { getRuntimeConfig } from '@/config/runtime'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { useTranslation } from '@/hooks/useTranslation'
import { MigrationDialog } from './MigrationDialog'
import { ImportedMemoryPanel } from './ImportedMemoryPanel'

/** Resolve the explicitly selected context target; never borrow another available target. */
export function ImportedMemorySettings({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('migrationMemory')
  const [selected, setSelected] = useState<{ target: GatewayServer; current: () => boolean } | null>(null)
  const [dialog, setDialog] = useState<{ scope: string; jobId?: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current, account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
    let disposed = false
    const valid = () => !disposed && generation.current === current && account(deviceId) && mount === getRuntimeConfig().appBasePath
    void fetchGatewayServers().then(targets => {
      const target = targets.find(target => target.id === deviceId)
      if (valid()) setSelected(target ? { target, current: valid } : null)
    }).catch(() => { if (valid()) setSelected(null) })
    const invalidate = () => { generation.current++; setSelected(null); setDialog(null); setRevision(value => value + 1) }
    const stop = listenAccountContextChanges(id => { if (id === deviceId) invalidate() })
    window.addEventListener('kcoder:servers-changed', invalidate)
    return () => { disposed = true; stop(); window.removeEventListener('kcoder:servers-changed', invalidate) }
  }, [deviceId, revision])
  const target = selected?.target
  if (!target || target.id !== deviceId || !selected.current()) return <p className="mt-4 text-sm text-text-secondary">{t('targetUnavailable')}</p>
  const scope = migrationSourceRecoveryScope(target)
  return <>
    <ImportedMemoryPanel key={scope} target={target} onImport={() => setDialog({ scope })} onOpenJob={jobId => setDialog({ scope, jobId })}/>
    {dialog?.scope === scope && <MigrationDialog target={target} initialMode={dialog.jobId ? 'batch' : 'memory'} initialJobId={dialog.jobId} onClose={() => setDialog(null)}/>}
  </>
}
