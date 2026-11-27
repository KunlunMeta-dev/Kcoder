import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { createSourceProductController } from '@/kcoder/migrationSourceProductController'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { SourceUploadState } from '../../../../shared/generated/contracts'

export function MigrationSourceProductPanel({ target, upload, isCurrent, onBusy, onInspect, onUnavailable }: {
  target: GatewayServer; upload: SourceUploadState; isCurrent: () => boolean; onBusy: (busy: boolean) => void;
  onInspect: (product: SourceUploadState) => void
  onUnavailable?: (operationId: string) => void
}) {
  const { t } = useTranslation('migrationUpload')
  const scope = migrationSourceRecoveryScope(target)
  const manager = useMemo(() => createSourceProductController({ upload, api: createMigrationApi(target.id, target.workspacePath), scope,
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    isCurrent: () => isCurrent() && scope === migrationSourceRecoveryScope(target) }), [upload, target, scope, isCurrent])
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const product = state.observed?.materialization
  useEffect(() => { manager.activate(); return () => manager.dispose() }, [manager])
  useEffect(() => { onBusy(state.busy); return () => onBusy(false) }, [state.busy, onBusy])
  useEffect(() => { if (state.unknown || product && product.stage !== 'ready') onUnavailable?.(upload.operationId) }, [state.unknown, product, onUnavailable, upload.operationId])
  useEffect(() => {
    if (!product || product.workerState !== 'running' || state.busy || state.unknown) return
    const timer = window.setTimeout(() => void manager.read(), 1000)
    return () => window.clearTimeout(timer)
  }, [product, state.busy, state.unknown, manager])
  const retry = state.pending && state.readAttempted && (state.pending.kind === 'cancel' || !product || state.pending.params.expectedSequence === product.sequence)
  return <section data-testid="migration-source-product" className="studio-card-spacing mt-4 space-y-3 rounded-lg border border-border" aria-busy={state.busy}>
    <h3 className="text-base font-medium">{t('product.title')}</h3><p className="text-sm leading-6 text-text-secondary">{t('product.boundary')}</p>
    <div className="flex flex-wrap gap-2">
      {!state.requested && <Button size="sm" disabled={state.busy} onClick={() => void manager.run()}>{t('product.start')}</Button>}
      <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void manager.read()}>{t('product.read')}</Button>
      {state.pending && <Button size="sm" variant="outline" disabled={state.busy || !retry} onClick={() => void manager.retry()}>{t('product.retry')}</Button>}
      {state.requested && product?.stage !== 'ready' && <Button size="sm" disabled={state.busy || product?.workerState !== 'stopped'} onClick={() => void manager.resume()}>{t('product.resume')}</Button>}
      {state.requested && product?.stage !== 'ready' && <Button size="sm" variant="outline" onClick={() => void manager.cancel()}>{t('product.cancel')}</Button>}
    </div>
    {state.error && <p role="alert" className="text-sm text-destructive">{t(`errors.${state.error}`)}</p>}
    {product && <div className="space-y-2" data-testid="source-product-status"><p className="text-sm font-medium">{t(`product.stages.${product.stage}`)}</p>
      <p className="text-sm text-text-secondary">{t('product.progress', { bytes: product.verifiedBytes.toLocaleString(), total: product.totalBytes.toLocaleString() })}</p>
      <p className="text-xs text-text-secondary">{t(`workers.${product.workerState}`)}</p>
      {state.unknown && <p className="text-sm text-text-secondary">{t('unknown')}</p>}
      {product.stage === 'ready' && !state.unknown && <><p className="text-sm leading-6 text-text-secondary">{t('product.ready')}</p><Button size="sm" onClick={() => { if (isCurrent()) onInspect(product) }}>{t('product.inspect')}</Button></>}
    </div>}
  </section>
}
