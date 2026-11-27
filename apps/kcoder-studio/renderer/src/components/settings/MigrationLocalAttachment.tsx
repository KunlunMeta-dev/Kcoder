import { MigrationUploadCollectionPanel } from './MigrationUploadCollection'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { MigrationAttachmentContext } from '@/kcoder/useMigrationAttachment'
import { useMigrationLocalAttachment } from '@/kcoder/useMigrationLocalAttachment'
import { useMigrationLocalAttachmentSelections } from '@/kcoder/migrationLocalAttachmentSelections'

export function MigrationLocalAttachment({ context, position, blockIndex }: {
  context: MigrationAttachmentContext; position: number; blockIndex: number
}) {
  const { t } = useTranslation('migration')
  const model = useMigrationLocalAttachment(context, position, blockIndex)
  const selections = useMigrationLocalAttachmentSelections()
  const input = useRef<HTMLInputElement>(null)
  const upload = model.state?.upload, local = upload?.localJob
  const running = Boolean(model.state?.workerRunning)
  const ready = local?.state.stage === 'ready'
  const progressBytes = local?.state.stage === 'copying' ? local.state.processedBytes : upload?.receivedBytes ?? 0
  const choosing = upload && ['prepared', 'receiving'].includes(upload.stage) && !upload.cancelRequested
  const detail = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  const error = model.error || model.state?.workerError || upload?.failureCode || local?.state.failureCode
  return (
    <section className="space-y-2 border-t border-border pt-3" data-testid="migration-local-attachment">
      <p className="font-medium">{t('local_attachment.title')}</p>
      <p className="text-text-secondary">{t('local_attachment.explanation')}</p>
      <input ref={input} type="file" className="hidden" tabIndex={-1}
        aria-label={t('local_attachment.choose_file')}
        onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void model.upload(file)
        }} />
      {upload && <p role="status" className="text-text-secondary">
        {running ? t('local_attachment.working') : ready ? t('local_attachment.ready') :
          local?.state.stage === 'cancelled' ? t('local_attachment.stages.cancelled') : t(`local_attachment.stages.${upload.stage}`)}
        {upload.filename ? ` · ${upload.filename}` : ''}
        {upload.bytes != null ? ` · ${detail(progressBytes)} / ${detail(upload.bytes)}` : ''}
      </p>}
      {model.hashing != null && <p role="status" className="text-text-secondary">
        {t('local_attachment.hashing', { bytes: detail(model.hashing) })}
      </p>}
      {ready && <p className="text-text-secondary">{t('local_attachment.unverified_original')}</p>}
      {ready && context.viewId && local?.state.receipt && selections && <label className="flex items-start gap-2 text-text-secondary">
        <input type="checkbox" className="mt-1" checked={selections.bindings.some(item => item.operationId === upload?.operationId)}
          disabled={model.busy || (selections.bindings.length >= 256 && !selections.bindings.some(item => item.operationId === upload?.operationId))}
          onChange={event => {
            if (upload && local.state.receipt) selections.select({ operationId: upload.operationId,
              selection: upload.selection, receipt: local.state.receipt }, event.currentTarget.checked)
          }} />
        <span>{t('local_attachment.use_for_continuation')}</span>
      </label>}
      {error && <p role="alert" className="text-destructive">
        {t(`errors.${error}`, { defaultValue: t('local_attachment.failed') })}
      </p>}
      <div className="flex flex-wrap gap-2">
        {!running && <Button size="sm" variant="outline" disabled={model.busy}
          onClick={() => void model.prepare()}>{t(upload ? 'local_attachment.new_selection' : 'local_attachment.prepare')}</Button>}
        {choosing && <Button size="sm" variant="outline" disabled={model.busy || running}
          onClick={() => input.current?.click()}>{t(upload.stage === 'receiving' ? 'local_attachment.choose_same_file' : 'local_attachment.choose_file')}</Button>}
        {upload?.stage === 'receiving' && upload.bytes != null && upload.receivedBytes === upload.bytes && !upload.cancelRequested &&
          <Button size="sm" variant="outline" disabled={model.busy || running}
            onClick={() => void model.finalize()}>{t('local_attachment.finalize_uploaded')}</Button>}
        {upload && !running && (upload.cancelRequested || ['cancelled', 'outcome_unknown'].includes(upload.stage)) &&
          <Button size="sm" variant="outline" disabled={model.busy}
            onClick={() => void model.resume()}>{t('local_attachment.resume')}</Button>}
        {local && !ready && !running && upload && !upload.cancelRequested &&
          <Button size="sm" variant="outline" disabled={model.busy}
            onClick={() => void model.run()}>{t('local_attachment.store')}</Button>}
        {upload && !ready && <Button size="sm" variant="outline" disabled={upload.cancelRequested}
          onClick={() => void model.cancel()}>{t(upload.cancelRequested ? 'branch.cancelling' : 'local_attachment.cancel')}</Button>}
        {upload && <Button size="sm" variant="ghost" disabled={model.busy}
          onClick={() => void model.refresh()}>{t('refresh')}</Button>}
        {ready && <Button size="sm" variant="outline" disabled={model.busy}
          onClick={() => void model.save()}>{t('attachment.download')}</Button>}
      </div>
      {model.items.length > 0 && <details className="space-y-2 text-text-secondary">
        <summary className="cursor-pointer">{t('local_attachment.existing')}</summary>
        <div className="flex flex-col items-start gap-2">
          {model.items.map(item => <Button key={item.operationId} size="sm" variant="ghost"
            disabled={model.busy || running} onClick={() => void model.open(item.operationId)}>
            {item.filename || t('local_attachment.pending_file')} · {t(`local_attachment.stages.${item.stage}`)}
          </Button>)}
          {model.nextCursor && <Button size="sm" variant="outline" disabled={model.busy || running}
            onClick={() => void model.listMore()}>{t('local_attachment.next_page')}</Button>}
        </div>
      </details>}
      <MigrationUploadCollectionPanel context={context} position={position} blockIndex={blockIndex} upload={upload} />
    </section>
  )
}
