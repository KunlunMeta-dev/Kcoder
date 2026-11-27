import { useState } from 'react'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { MigrationDialog } from './MigrationDialog'
import { ImportedMemoryPanel } from './ImportedMemoryPanel'

/** Use the context page's resolved target without choosing another host. */
export function ImportedMemorySettings({ target }: { target: GatewayServer }) {
  // Directory DTOs belong to one read; replacement also retires its open dialog.
  const [dialog, setDialog] = useState<{ target: GatewayServer; jobId?: string } | null>(null)
  const scope = migrationSourceRecoveryScope(target)
  return <>
    <ImportedMemoryPanel key={scope} target={target} onImport={() => setDialog({ target })} onOpenJob={jobId => setDialog({ target, jobId })}/>
    {dialog?.target === target && <MigrationDialog target={target} initialMode={dialog.jobId ? 'batch' : 'memory'} initialJobId={dialog.jobId} onClose={() => setDialog(null)}/>}
  </>
}
