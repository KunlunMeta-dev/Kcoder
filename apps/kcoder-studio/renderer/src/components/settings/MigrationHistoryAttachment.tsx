import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  useMigrationAttachment,
  type MigrationAttachmentContext,
} from '@/kcoder/useMigrationAttachment'
import { MigrationLocalAttachment } from './MigrationLocalAttachment'
export function MigrationHistoryAttachment({
  context,
  position,
  blockIndex,
}: {
  context: MigrationAttachmentContext
  position: number
  blockIndex: number
}) {
  const { t } = useTranslation('migration'),
    model = useMigrationAttachment(context, position, blockIndex)
  const job = model.result?.job,
    info = job?.info,
    running = Boolean(model.result?.workerRunning),
    ready = job?.stage === 'ready'
  const handingOff =
    model.downloaded != null && info?.receipt != null && model.downloaded >= info.receipt.bytes
  const detail = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return (
    <section
      className="studio-card-spacing my-2 min-w-0 space-y-2 rounded-lg border border-border text-sm"
      data-testid="migration-history-attachment"
      aria-busy={model.busy || running}
    >
      <p className="break-words font-medium">{info?.displayName || t('attachment.title')}</p>
      {job && (
        <p role="status" className="text-text-secondary">
          {t(
            running && ['cancelled', 'failed'].includes(job.stage)
              ? 'attachment.resuming'
              : !running && ['inspecting', 'extracting'].includes(job.stage)
                ? 'attachment.idle'
                : `attachment.stages.${job.stage}`
          )}
          {running || ready ? ` · ${detail(job.processedBytes)}` : ''}
        </p>
      )}
      {info?.issue && (
        <p className="text-text-secondary">
          {t(`errors.${info.issue}`, { defaultValue: t('attachment.unavailable') })}
        </p>
      )}
      {(model.error || job?.failureCode || model.result?.workerError) && (
        <p role="alert" className="text-destructive">
          {t(`errors.${model.error || job?.failureCode || model.result?.workerError}`, {
            defaultValue: t('attachment.failed'),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!running && !ready && job?.stage !== 'unavailable' && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || !model.result}
            onClick={() => void model.run()}
          >
            {t(
              job && ['cancelled', 'failed'].includes(job.stage)
                ? 'attachment.resume'
                : 'attachment.run'
            )}
          </Button>
        )}
        {running && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || job?.cancelRequested}
            onClick={() => void model.cancel()}
          >
            {t(job?.cancelRequested ? 'branch.cancelling' : 'attachment.cancel')}
          </Button>
        )}
        {ready && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy}
            onClick={() => void model.save()}
          >
            {t('attachment.download')}
          </Button>
        )}
        {model.downloaded != null && (
          <>
            <span className="self-center text-text-secondary">
              {t(handingOff ? 'attachment.saving_local' : 'attachment.downloading', {
                bytes: detail(model.downloaded),
              })}
            </span>
            {!handingOff && (
              <Button size="sm" variant="ghost" onClick={model.cancelDownload}>
                {t('attachment.cancel_download')}
              </Button>
            )}
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={model.busy}
          onClick={() => void model.refresh()}
        >
          {t('refresh')}
        </Button>
      </div>
      {info?.kind === 'local_reference' && <MigrationLocalAttachment
        context={context} position={position} blockIndex={blockIndex} />}
    </section>
  )
}
