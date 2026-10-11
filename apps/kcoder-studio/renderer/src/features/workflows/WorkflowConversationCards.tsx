import { useEffect, useState } from 'react'
import { GitBranch, Play, PanelRightOpen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { workflowApi, type WorkflowDefinition } from './workflowApi'
import { workflowReferenceKey, type WorkflowReference } from './workflowReferences'
export function WorkflowConversationCards({
  serverId,
  conversationId,
  references,
  onOpen,
  onUse,
  disabled,
  newConversation = false,
}: {
  serverId: string
  conversationId?: string
  references: WorkflowReference[]
  onOpen: (ref: WorkflowReference) => void
  onUse: (text: string, reference: WorkflowReference) => void | Promise<void>
  disabled: boolean
  newConversation?: boolean
}) {
  const scope = usePluginTargetScope(serverId)
  const storageKey = JSON.stringify([
    'kcoder:workflow-card-dismissals',
    serverId,
    conversationId,
    scope.key,
  ])
  const [dismissals, setDismissals] = useState<{ key: string; values: string[] }>(() => ({
    key: storageKey,
    values: [],
  }))
  const readDismissals = () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').slice(-64)
        : []
    } catch {
      return []
    }
  }
  const hidden =
    dismissals.key === storageKey ? [...readDismissals(), ...dismissals.values] : readDismissals()
  const dismissalKey = (ref: WorkflowReference) =>
    `${workflowReferenceKey(ref)}:${ref.revision ?? ''}`
  const visible = references.filter(ref => !hidden.includes(dismissalKey(ref))).slice(-3)
  const dismiss = (ref: WorkflowReference) => {
    if (!scope.isCurrent()) return
    const values = [...new Set([...hidden, dismissalKey(ref)])].slice(-64)
    setDismissals({ key: storageKey, values })
    if (conversationId) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(values))
      } catch {
        /* Keep in-memory dismissal. */
      }
    }
  }
  if (!visible.length) return null
  return (
    <div key={scope.key} data-testid="workflow-conversation-cards" className="mb-2 space-y-2">
      {visible.map(ref => (
        <Card
          key={workflowReferenceKey(ref)}
          reference={ref}
          onDismiss={() => dismiss(ref)}
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
  onDismiss,
  serverId,
  isCurrent,
  onOpen,
  onUse,
  disabled,
  newConversation,
}: {
  reference: WorkflowReference
  onDismiss: () => void
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
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0 max-md:h-11 max-md:w-11"
          aria-label={t('workflowFlow.dismissCard')}
          title={t('workflowFlow.dismissCard')}
          data-testid="workflow-card-dismiss"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {reference.needsInput && (
        <p className="mt-1 text-xs text-text-secondary">{t('workflowFlow.needsInput')}</p>
      )}
      {error && (
        <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => setRetry(n => n + 1)}>
            {t('workflowCanvas.reload')}
          </Button>
        </div>
      )}
    </section>
  )
}
