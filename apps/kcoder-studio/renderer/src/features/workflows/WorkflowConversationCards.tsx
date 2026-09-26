import { useEffect, useState } from 'react'
import { GitBranch, Play, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
import { workflowReferenceKey, type WorkflowReference } from './workflowReferences'
export function WorkflowConversationCards({
  serverId,
  references,
  onOpen,
  onUse,
  disabled,
  newConversation = false,
}: {
  serverId: string
  references: WorkflowReference[]
  onOpen: (ref: WorkflowReference) => void
  onUse: (text: string, reference: WorkflowReference) => void | Promise<void>
  disabled: boolean
  newConversation?: boolean
}) {
  const scope = usePluginTargetScope(serverId)
  return (
    <div key={scope.key} data-testid="workflow-conversation-cards" className="mb-2 space-y-2">
      {references.slice(-3).map(ref => (
        <Card
          key={workflowReferenceKey(ref)}
          reference={ref}
          serverId={serverId}
          isCurrent={scope.isCurrent}
          onOpen={onOpen}
          onUse={onUse}
          disabled={disabled}
          newConversation={newConversation}
        />
      ))}
    </div>
  )
}
function Card({
  reference,
  serverId,
  isCurrent,
  onOpen,
  onUse,
  disabled,
  newConversation,
}: {
  reference: WorkflowReference
  serverId: string
  isCurrent: () => boolean
  onOpen: (ref: WorkflowReference) => void
  onUse: (text: string, reference: WorkflowReference) => void | Promise<void>
  disabled: boolean
  newConversation: boolean
}) {
  const { t } = useTranslation('common')
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const { id, version } = reference
  const [using, setUsing] = useState(false)
  const publishedVersion = version ?? definition?.savedVersion
  useEffect(() => {
    let stopped = false
    const request = version
      ? workflowApi.exportDefinition(serverId, id, version)
      : workflowApi.read(serverId, id)
    void request
      .then(next => {
        if (!stopped && isCurrent()) {
          if (next.id !== id || (version && next.savedVersion !== version))
            throw new Error(t('workflowReuse.versionMismatch'))
          setDefinition(next)
          setError('')
        }
      })
      .catch(e => {
        if (!stopped && isCurrent()) {
          setDefinition(null)
          setError(String(e instanceof Error ? e.message : e))
        }
      })
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ serverId: string; id: string }>).detail
      if (detail?.serverId === serverId && detail.id === id && isCurrent()) setRetry(n => n + 1)
    }
    window.addEventListener('kcoder:workflow-definition-changed', changed)
    return () => {
      stopped = true
      window.removeEventListener('kcoder:workflow-definition-changed', changed)
    }
  }, [serverId, id, version, isCurrent, retry, reference.revision, t])
  return (
    <section
      className="rounded-xl border border-border/70 bg-background px-3 py-2"
      data-testid="workflow-conversation-card"
      data-workflow-id={id}
    >
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {definition?.title ?? t('workflowCanvas.heading')}
        </span>
        <span className="text-xs text-text-muted">
          {version
            ? `v${version}`
            : definition?.status === 'saved'
              ? t('workflowFlow.savedVersion', { version: definition.savedVersion })
              : t('workflowCanvas.draft')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!definition}
          data-testid="workflow-card-open"
          onClick={() => isCurrent() && onOpen(reference)}
        >
          <PanelRightOpen />
          {t('workflowFlow.viewCanvas')}
        </Button>
        {publishedVersion && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || using || !definition}
            data-testid="workflow-card-use"
            onClick={() => {
              if (!isCurrent() || !definition) return
              setUsing(true)
              void workflowApi
                .exportDefinition(serverId, id, publishedVersion)
                .then(async saved => {
                  if (!isCurrent()) return
                  await onUse(
                    t('workflowReuse.conversationInstruction', {
                      title: saved.title,
                      params: JSON.stringify({ definition_id: id, version: publishedVersion }),
                    }),
                    { id, title: saved.title, version: publishedVersion }
                  )
                })
                .catch(e => {
                  if (isCurrent()) setError(String(e instanceof Error ? e.message : e))
                })
                .finally(() => {
                  if (isCurrent()) setUsing(false)
                })
            }}
          >
            <Play />
            {t(newConversation ? 'workflowFlow.useNew' : 'workflowFlow.useVersion', {
              version: publishedVersion,
            })}
          </Button>
        )}
      </div>
      {reference.needsInput && (
        <p className="mt-1 text-xs text-text-secondary">{t('workflowFlow.needsInput')}</p>
      )}
      {error && (
        <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-error">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => setRetry(n => n + 1)}>
            {t('workflowCanvas.reload')}
          </Button>
        </div>
      )}
    </section>
  )
}
