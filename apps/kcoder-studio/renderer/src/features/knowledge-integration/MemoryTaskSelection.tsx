import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeIntegrationClient } from './client'
import { useDomainPage } from './useDomainPage'
import { OperationError, PageActions } from './shared'
/** The snapshot proves preparation, not that a provider received the complete model request. */
function SnapshotRows({
  client,
  taskId,
  threadId,
}: {
  client: KnowledgeIntegrationClient
  taskId: string
  threadId?: string
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(
    JSON.stringify([client.ownerKey, threadId, taskId]),
    async (after, signal) => {
      const { snapshot } = await client.readMemoryTaskSnapshot(taskId, signal, threadId)
      const offset = after ? Number(after) : 0
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('invalid local snapshot page')
      const items = snapshot?.memories.slice(offset, offset + 10) ?? []
      return {
        items,
        nextCursor: snapshot && offset + 10 < snapshot.memories.length ? String(offset + 10) : null,
      }
    }
  )
  return (
    <div aria-busy={page.pending}>
      <p className="mt-3 text-sm text-text-secondary">{t('taskSelectionHint')}</p>
      <OperationError error={page.error} />
      <ul className="mt-3 space-y-3">
        {!page.pending &&
          page.items.map(memory => (
            <li key={`${memory.id}-${memory.revision}`} className="space-y-1 text-sm">
              <h4 className="font-medium">{memory.proposal.title}</h4>
              <p className="whitespace-pre-wrap">{memory.proposal.content}</p>
              <p className="text-text-muted">
                {t('taskSelectionReason', { revision: memory.revision })}
              </p>
            </li>
          ))}
      </ul>
      {!page.pending && !page.items.length && !page.error && (
        <p className="mt-3 text-sm text-text-muted">{t('noTaskSelection')}</p>
      )}
      <PageActions {...page} />
    </div>
  )
}

/** The locator comes from the native turn event; the readonly RPC rechecks current authority. */
export function MemoryTaskSelection({
  client,
  taskId,
  threadId,
}: {
  client: KnowledgeIntegrationClient
  taskId: string
  threadId?: string
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [open, setOpen] = useState(false)
  return (
    <details
      className="studio-card-spacing workbench-card"
      data-testid="memory-task-selection"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary
        className="flex min-h-11 cursor-pointer items-center rounded-lg font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-testid="memory-task-selection-toggle"
      >
        {t('taskSelection')}
      </summary>
      {open && (
        <SnapshotRows
          key={JSON.stringify([client.ownerKey, threadId, taskId])}
          client={client}
          taskId={taskId}
          threadId={threadId}
        />
      )}
    </details>
  )
}
