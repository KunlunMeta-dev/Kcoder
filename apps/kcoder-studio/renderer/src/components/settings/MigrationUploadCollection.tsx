import { useMigrationLocalAttachmentSelections } from '@/kcoder/migrationLocalAttachmentSelections'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationUploadCollection } from '@/kcoder/useMigrationUploadCollection'
import type { MigrationAttachmentContext } from '@/kcoder/useMigrationAttachment'
import type {
  HistoricalAttachmentSelection,
  HistoricalLocalAttachmentUpload,
  MigrationUploadCollection,
} from '../../../../shared/generated/contracts'

type Props = {
  context: MigrationAttachmentContext
  position: number
  blockIndex: number
  upload?: HistoricalLocalAttachmentUpload
}
export function MigrationUploadCollectionPanel(props: Props) {
  const { t } = useTranslation('migration')
  const [expanded, setExpanded] = useState(false)
  return (
    <details
      className="space-y-2 border-t border-border pt-3"
      data-testid="migration-upload-collection"
      onToggle={event => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-text-secondary">
        {t('upload_collection.title')}
      </summary>
      <p className="pt-2 text-text-secondary">{t('upload_collection.boundary')}</p>
      {expanded && <CollectionContent {...props} />}
    </details>
  )
}
function CollectionContent({ context, position, blockIndex, upload }: Props) {
  const { t } = useTranslation('migration')
  const selection = useMemo<HistoricalAttachmentSelection>(
    () => ({
      jobId: context.jobId,
      viewId: context.viewId,
      position,
      blockIndex,
      toolItemIndex: context.toolItemIndex,
    }),
    [context.jobId, context.viewId, position, blockIndex, context.toolItemIndex]
  )
  const model = useMigrationUploadCollection(context, selection, upload)
  const selections = useMigrationLocalAttachmentSelections()
  const finalJob = model.finalJob
  const binding =
    finalJob?.state.stage === 'ready' && finalJob.state.receipt
      ? {
          operationId: finalJob.state.operationId,
          selection: finalJob.selection,
          receipt: finalJob.state.receipt,
        }
      : null
  const [confirmation, setConfirmation] = useState<{
    scope: typeof model.scope
    job: MigrationUploadCollection
    action: 'run' | 'resume'
    word: string
  } | null>(null)
  const value = model.result?.collection
  const running = Boolean(model.result?.workerRunning || model.result?.workerScheduled)
  const confirm =
    confirmation?.scope === model.scope &&
    value?.operationId === confirmation.job.operationId &&
    value.collectionId === confirmation.job.collectionId &&
    value.sequence === confirmation.job.sequence
      ? confirmation
      : null
  const error = model.error || model.result?.workerError || value?.failureCode
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-destructive">
          {t(`errors.${error}`, { defaultValue: t('upload_collection.check_outcome') })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="migration-collection-prepare"
          disabled={!upload || model.busy || running || !!model.error}
          onClick={() => void model.prepare()}
        >
          {t('upload_collection.prepare')}
        </Button>
        <Button size="sm" variant="ghost" disabled={model.busy} onClick={model.refresh}>
          {t('refresh')}
        </Button>
      </div>
      {value && (
        <div className="space-y-2">
          <p role="status" data-testid="migration-collection-status">
            {t(`upload_collection.stages.${value.stage}`)}
          </p>
          {model.result?.workerRunning ? (
            <p className="text-text-secondary">{t('upload_collection.working')}</p>
          ) : model.result?.workerScheduled ? (
            <p className="text-text-secondary">{t('upload_collection.scheduled')}</p>
          ) : null}
          {value.cancelRequested && (
            <p className="text-text-secondary">{t('upload_collection.cancel_requested')}</p>
          )}
          {value.storageRetired && (
            <p className="text-text-secondary">{t('upload_collection.retired')}</p>
          )}
          <p className="text-text-secondary">
            {t('upload_collection.progress', {
              bytes: value.deletedBytes.toLocaleString(),
              reserved: value.releasedReservationBytes.toLocaleString(),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {value.stage === 'collected' && (
              <Button
                size="sm"
                variant="outline"
                data-testid="migration-collection-download"
                disabled={model.busy}
                onClick={() => void model.save()}
              >
                {t('upload_collection.download')}
              </Button>
            )}
            {value.stage !== 'collected' &&
              !running &&
              !value.cancelRequested &&
              ['prepared', 'collecting'].includes(value.stage) && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-collection-run"
                  disabled={model.busy || !!model.error}
                  onClick={() =>
                    setConfirmation({ scope: model.scope, job: value, action: 'run', word: '' })
                  }
                >
                  {t('upload_collection.run')}
                </Button>
              )}
            {value.stage !== 'collected' &&
              !running &&
              (value.cancelRequested ||
                ['cancelled', 'blocked', 'outcome_unknown'].includes(value.stage)) && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="migration-collection-resume"
                  disabled={model.busy || !!model.error}
                  onClick={() =>
                    setConfirmation({ scope: model.scope, job: value, action: 'resume', word: '' })
                  }
                >
                  {t('upload_collection.resume')}
                </Button>
              )}
            {value.stage !== 'collected' && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="migration-collection-cancel"
                disabled={value.cancelRequested}
                onClick={() => void model.cancel()}
              >
                {t('upload_collection.cancel')}
              </Button>
            )}
          </div>
          {confirm && (
            <div
              className="studio-card-spacing space-y-2 rounded-lg border border-border"
              data-testid="migration-collection-confirm"
            >
              <p>
                {t(
                  confirm.action === 'run'
                    ? 'upload_collection.confirmation'
                    : 'upload_collection.resume_confirmation'
                )}
              </p>
              <label className="flex flex-col gap-1 text-text-secondary">
                {t('upload_collection.type_confirmation', {
                  word: confirm.action === 'run' ? 'COLLECT' : 'RESUME',
                })}
                <input
                  className="rounded-md border border-border bg-background px-2 py-1 text-text-primary"
                  value={confirm.word}
                  onChange={event =>
                    setConfirmation({ ...confirm, word: event.currentTarget.value })
                  }
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="migration-collection-confirm-submit"
                  disabled={
                    model.busy || confirm.word !== (confirm.action === 'run' ? 'COLLECT' : 'RESUME')
                  }
                  onClick={() => {
                    setConfirmation(null)
                    void model.run(confirm.job, confirm.action)
                  }}
                >
                  {t('upload_collection.confirm')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={model.busy}
                  onClick={() => setConfirmation(null)}
                >
                  {t('upload_collection.dismiss')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {binding && context.viewId && selections && (
        <label className="flex items-start gap-2 text-text-secondary">
          <input
            type="checkbox"
            checked={selections.bindings.some(item => item.operationId === binding.operationId)}
            disabled={
              model.busy ||
              (selections.bindings.length >= 256 &&
                !selections.bindings.some(item => item.operationId === binding.operationId))
            }
            onChange={event => selections.select(binding, event.currentTarget.checked)}
          />
          <span>{t('local_attachment.use_for_continuation')}</span>
        </label>
      )}
      {model.items.length > 0 && (
        <div className="space-y-2" data-testid="migration-collection-records">
          <p className="text-text-secondary">{t('upload_collection.records')}</p>
          {model.items.map(
            item =>
              item.collection && (
                <Button
                  className="max-w-full"
                  key={item.collection.operationId}
                  size="sm"
                  variant="ghost"
                  disabled={model.busy || running}
                  onClick={() => model.choose(item.collection!.operationId)}
                >
                  {item.collection.operationId.slice(0, 8)} ·{' '}
                  {t(`upload_collection.stages.${item.collection.stage}`)}
                </Button>
              )
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={model.busy || model.pages.length < 2}
              onClick={() => void model.previousPage()}
            >
              {t('upload_collection.previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={model.busy || !model.next}
              onClick={() => void model.nextPage()}
            >
              {t('upload_collection.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
