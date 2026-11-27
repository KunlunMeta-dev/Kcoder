import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { InstructionPreviewController } from '../../../../shared/migrationInstructionPreview'
import { MigrationInstructionBodyView } from './MigrationInstructionBodyView'

export function MigrationInstructionSavedPreview({ deviceId, workspacePath, jobId, itemId, isCurrent }: {
  deviceId: string; workspacePath?: string; jobId: string; itemId: string; isCurrent(): boolean
}) {
  const { t } = useTranslation('migrationInstructions')
  const model = useMemo(() => {
    const account = captureAccountContextRevision()
    return new InstructionPreviewController(createMigrationApi(deviceId, workspacePath), { kind: 'job', jobId }, () => isCurrent() && account(deviceId))
  }, [deviceId, workspacePath, jobId, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { model.activate(); return model.dispose }, [model])
  const body = state.body
  return <div className="mt-2 space-y-2" data-testid={`instruction-saved-preview-${itemId}`}>
    <Button size="sm" variant="ghost" onClick={() => setExpanded(value => !value)}>{t('savedPreview')}</Button>
    {expanded && <><p className="text-xs text-text-secondary">{t('previewBoundary')}</p><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void model.preview(itemId, 'original')}>{t('original')}</Button><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void model.preview(itemId, 'compiled')}>{t('compiled')}</Button></div>
      {state.error && <p role="alert" className="text-xs text-text-secondary">{t('unsupported')}</p>}
      {body && <MigrationInstructionBodyView body={body} busy={state.busy} onNext={() => { if (body.nextOffset != null) void model.preview(itemId, body.representation, body.nextOffset) }}/> }
    </>}
  </div>
}
