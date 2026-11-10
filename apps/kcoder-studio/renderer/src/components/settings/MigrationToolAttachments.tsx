import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  useMigrationAttachment,
  type MigrationAttachmentContext,
} from '@/kcoder/useMigrationAttachment'
import { MigrationHistoryAttachment } from './MigrationHistoryAttachment'
export function MigrationToolAttachments({
  context,
  position,
  blockIndex,
}: {
  context: MigrationAttachmentContext
  position: number
  blockIndex: number
}) {
  const { t } = useTranslation('migration')
  const model = useMigrationAttachment({ ...context, toolAttachments: true }, position, blockIndex)
  const [cursors, setCursors] = useState([0])
  const job = model.result?.job,
    running = Boolean(model.result?.workerRunning),
    done = job?.stage === 'catalogued'
  const load = async (cursor: number, stack: number[]) => {
    if (await model.loadItems(cursor)) setCursors(stack)
  }
  return (
    <section
      className="studio-card-spacing my-2 min-w-0 space-y-2 rounded-lg border border-border text-sm"
      data-testid="migration-tool-attachments"
      aria-busy={model.busy || running}
    >
      <p className="font-medium">{t('tool_attachments.title')}</p>
      {job && (
        <p role="status" className="text-text-secondary">
          {t(
            done
              ? 'tool_attachments.catalogued'
              : !running && ['inspecting', 'extracting'].includes(job.stage)
                ? 'attachment.idle'
                : `attachment.stages.${job.stage}`
          )}
        </p>
      )}
      {job?.catalog && (
        <p className="text-text-secondary">
          {t(job.catalog.structured ? 'tool_attachments.count' : 'tool_attachments.unstructured', {
            count: job.catalog.attachments,
          })}
        </p>
      )}
      {(model.error || job?.failureCode || model.result?.workerError) && (
        <p role="alert" className="text-destructive">
          {t(`errors.${model.error || job?.failureCode || model.result?.workerError}`, {
            defaultValue: t('tool_attachments.failed'),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!running && !done && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy || !model.result}
            onClick={() => void model.run()}
          >
            {t(
              job && ['cancelled', 'failed'].includes(job.stage)
                ? 'tool_attachments.resume'
                : 'tool_attachments.run'
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
        {done && (
          <Button
            size="sm"
            variant="outline"
            disabled={model.busy}
            onClick={() => void load(0, [0])}
          >
            {t('tool_attachments.inspect')}
          </Button>
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
      {job?.catalog && (job.catalog.unknownItems > 0 || job.catalog.opaqueItems > 0) && (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">{t('tool_attachments.excluded')}</summary>
          <p>
            {t('tool_attachments.excluded_count', {
              unknown: job.catalog.unknownItems,
              opaque: job.catalog.opaqueItems,
            })}
          </p>
        </details>
      )}
      {model.items && (
        <>
          <div className="max-h-96 space-y-2 overflow-y-auto overscroll-contain">
            {model.items.items.map(item => (
              <div key={item.index}>
                <p className="text-xs text-text-muted">
                  {t('tool_attachments.item', {
                    index: item.index + 1,
                    source: item.sourceArrayIndex + 1,
                  })}
                </p>
                <MigrationHistoryAttachment
                  context={{ ...context, toolAttachments: true, toolItemIndex: item.index }}
                  position={position}
                  blockIndex={blockIndex}
                />
              </div>
            ))}
            {model.items.items.length === 0 && (
              <p className="text-text-secondary">{t('tool_attachments.empty')}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={model.busy || cursors.length < 2}
              onClick={() => {
                const previous = cursors.slice(0, -1)
                void load(previous.at(-1)!, previous)
              }}
            >
              {t('previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={model.busy || model.items.nextCursor == null}
              onClick={() => {
                const next = model.items?.nextCursor
                if (next != null) void load(next, [...cursors, next])
              }}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
