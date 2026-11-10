import { MemoryTaskSelection } from './MemoryTaskSelection'
import { useDomainAction } from './useDomainAction'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { ReviewedMemory } from '../../../../shared/generated/contracts'
import type { KnowledgeIntegrationClient } from './client'
import { fieldClass, OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'
function MemoryRow({
  memory,
  client,
  refresh,
}: {
  memory: ReviewedMemory
  client: KnowledgeIntegrationClient
  refresh: () => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const [draft, setDraft] = useState({
    revision: memory.revision,
    baseline: memory.proposal.content,
    content: memory.proposal.content,
  })
  const dirty = draft.content !== draft.baseline
  if (draft.revision !== memory.revision && !dirty)
    setDraft({
      revision: memory.revision,
      baseline: memory.proposal.content,
      content: memory.proposal.content,
    })
  const content = draft.content
  const actionMemory = { ...memory, revision: draft.revision }
  const action = useDomainAction(refresh, client)
  const [removeRequested, setRemoveRequested] = useState(false)
  return (
    <article
      className="studio-card-spacing workbench-card workbench-card-interactive space-y-4"
      data-testid="reviewed-memory-row"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-text-primary">{memory.proposal.title}</h3>
        <p className="text-sm text-text-muted">
          {t(memory.reviewStatus === 'candidate' ? 'candidate' : memory.reviewStatus)} ·{' '}
          {t(memory.enabled ? 'enabled' : 'disabled')}
        </p>
      </div>
      <p className="text-xs text-text-muted">
        {t('memoryMetadata', {
          category: memory.proposal.category,
          scope: memory.owner.workspaceId ? t('projectScope') : t('personalScope'),
          time: new Date(memory.updatedAtMs).toLocaleString(
            i18n?.resolvedLanguage || i18n?.language || 'en'
          ),
        })}
      </p>
      <label className="block space-y-1 text-sm">
        <span>{t('content')}</span>
        <textarea
          className={fieldClass}
          rows={4}
          value={content}
          onChange={e => setDraft(old => ({ ...old, content: e.target.value }))}
          data-testid="memory-content"
          disabled={action.blocked}
        />
      </label>
      {draft.revision !== memory.revision && dirty && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-sm text-text-secondary"
        >
          <div className="w-full space-y-2">
            <p>{t('draftConflict')}</p>
            <p className="text-xs text-text-muted">
              {t('serverVersion', { revision: memory.revision })}
            </p>
            <pre
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background p-3 text-sm"
              data-testid="memory-server-content"
            >
              {memory.proposal.content}
            </pre>
          </div>
          <Button
            variant="outline"
            disabled={action.blocked}
            onClick={() =>
              setDraft(old => ({
                ...old,
                revision: memory.revision,
                baseline: memory.proposal.content,
              }))
            }
            data-testid="memory-merge-current"
          >
            {t('mergeWithCurrent')}
          </Button>
          <Button
            variant="outline"
            disabled={action.blocked}
            onClick={() =>
              setDraft({
                revision: memory.revision,
                baseline: memory.proposal.content,
                content: memory.proposal.content,
              })
            }
            data-testid="memory-load-current"
          >
            {t('loadCurrent')}
          </Button>
        </div>
      )}
      <p className="text-xs text-text-muted">{t('unverified')}</p>
      <details className="text-sm text-text-secondary">
        <summary className="cursor-pointer" data-testid="memory-sources-toggle">
          {t('source')}
        </summary>
        <ul className="mt-2 space-y-2">
          {memory.proposal.provenance.map((source, index) => (
            <li key={`${source.sourceId}-${index}`} className="break-words">
              <p>{source.description}</p>
              <code className="text-xs">
                {source.kind} · {source.sourceId} · {source.sourceRevision}
              </code>
            </li>
          ))}
        </ul>
      </details>
      {removeRequested && (
        <div
          className="studio-card-spacing space-y-2 rounded-xl border border-destructive/20 text-sm"
          data-testid="memory-delete-confirmation"
        >
          <p>{t('removeMemoryConfirm', { title: memory.proposal.title })}</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={action.blocked}
              onClick={() => void action.run(() => client.removeMemory(memory))}
              data-testid="memory-confirm-delete"
            >
              {t('confirmRemove')}
            </Button>
            <Button
              variant="ghost"
              disabled={action.blocked}
              onClick={() => setRemoveRequested(false)}
              data-testid="memory-cancel-delete"
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      <OperationError error={action.error} onInspect={() => void action.inspect()} />
      <div className="flex flex-wrap gap-2" aria-busy={action.pending}>
        <Button
          variant="ghost"
          disabled={action.blocked}
          onClick={() => setRemoveRequested(true)}
          data-testid="memory-delete"
        >
          {t('removeMemory')}
        </Button>
        {memory.reviewStatus === 'candidate' ? (
          <>
            <Button
              disabled={action.blocked || !content.trim()}
              onClick={() =>
                void action.run(() =>
                  client.reviewMemory(actionMemory, { action: 'accept', editedContent: content })
                )
              }
              data-testid="memory-accept"
            >
              {t('accept')}
            </Button>
            <Button
              variant="outline"
              disabled={action.blocked}
              onClick={() =>
                void action.run(() => client.reviewMemory(actionMemory, { action: 'reject' }))
              }
              data-testid="memory-reject"
            >
              {t('reject')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={action.blocked || content === memory.proposal.content || !content.trim()}
              onClick={() => void action.run(() => client.editMemory(actionMemory, content))}
              data-testid="memory-save"
            >
              {t('save')}
            </Button>
            {memory.reviewStatus === 'confirmed' && (
              <Button
                variant="secondary"
                disabled={action.blocked}
                onClick={() =>
                  void action.run(() => client.setMemoryEnabled(actionMemory, !memory.enabled))
                }
                data-testid="memory-toggle"
              >
                {t(memory.enabled ? 'disable' : 'enable')}
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  )
}
export function MemoryCenter({
  client,
  taskId,
  threadId,
}: {
  client: KnowledgeIntegrationClient
  taskId?: string
  threadId?: string
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) => client.listMemories(after, signal))
  const action = useDomainAction(page.refresh, client)
  const [title, setTitle] = useState(''),
    [content, setContent] = useState('')
  return (
    <section className="studio-card-stack" data-testid="memory-center">
      <p className="text-sm text-text-secondary">{t('memoryHint')}</p>
      {taskId && <MemoryTaskSelection client={client} taskId={taskId} threadId={threadId} />}
      <section className="studio-card-spacing workbench-card">
        <h2 className="font-medium" data-testid="memory-create-toggle">
          {t('addMemory')}
        </h2>
        <form
          className="mt-4 space-y-3"
          onSubmit={e => {
            e.preventDefault()
            void action
              .run(async () => {
                const memory = await client.proposeMemory({
                  title:
                    title.trim() ||
                    Array.from(content.trim().split(/\r?\n/)[0]).slice(0, 256).join(''),
                  content,
                  category: 'user',
                  origin: 'manual',
                  provenance: [],
                  validUntilMs: null,
                })
                await client.reviewMemory(memory, {
                  action: 'accept',
                  editedContent: memory.proposal.content,
                })
              })
              .then(ok => {
                if (ok) {
                  setTitle('')
                  setContent('')
                }
              })
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>{t('optionalMemoryTitle')}</span>
            <input
              className={fieldClass}
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={256}
              disabled={action.blocked}
              data-testid="memory-new-title"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t('content')}</span>
            <textarea
              className={fieldClass}
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={4}
              required
              disabled={action.blocked}
              data-testid="memory-new-content"
            />
          </label>
          <OperationError error={action.error} onInspect={() => void action.inspect()} />
          <Button
            type="submit"
            disabled={action.blocked || !content.trim()}
            data-testid="memory-propose"
          >
            {t('saveMemoryAndEnable')}
          </Button>
        </form>
      </section>
      <OperationError error={page.error} />
      <div aria-busy={page.pending} className="studio-card-stack">
        {page.pending && (
          <p role="status" className="text-sm text-text-muted">
            {t('loading')}
          </p>
        )}
        {!page.pending && !page.error && !page.items.length && (
          <p className="text-text-muted">{t('empty')}</p>
        )}
        {page.items.map(memory => (
          <MemoryRow key={memory.id} memory={memory} client={client} refresh={page.refresh} />
        ))}
      </div>
      <PageActions {...page} />
    </section>
  )
}
