import { useCallback, useEffect, useState } from 'react'
import { Save, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowNodeEditor } from './WorkflowNodeEditor'
import { newerDefinition, workflowApi, type WorkflowDefinition } from './workflowApi'

export function WorkflowConversationCanvas({
  serverId,
  definitionId,
}: {
  serverId: string
  definitionId: string
}) {
  const scope = usePluginTargetScope(serverId)
  return (
    <ConversationCanvas
      key={`${scope.key}:${definitionId}`}
      serverId={serverId}
      definitionId={definitionId}
      isCurrent={scope.isCurrent}
    />
  )
}

function ConversationCanvas({
  serverId,
  definitionId,
  isCurrent,
}: {
  serverId: string
  definitionId: string
  isCurrent: () => boolean
}) {
  const { t } = useTranslation('common')
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const apply = useCallback(
    (next: WorkflowDefinition) => {
      if (isCurrent()) setDefinition(current => newerDefinition(current, next))
    },
    [isCurrent]
  )
  useEffect(() => {
    let stopped = false,
      inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const next = await workflowApi.read(serverId, definitionId)
        if (stopped || !isCurrent()) return
        apply(next)
        timer = setTimeout(() => void poll(), 750)
      } catch (failure) {
        if (stopped || !isCurrent()) return
        setDefinition(null)
        setSelected(null)
        setDirty(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        inFlight = false
      }
    }
    const visible = () => {
      if (timer) clearTimeout(timer)
      if (document.visibilityState !== 'hidden') void poll()
    }
    void poll()
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [serverId, definitionId, isCurrent, apply, retry])
  const mutate = async (action: () => Promise<WorkflowDefinition>) => {
    setBusy(true)
    setError(null)
    try {
      apply(await action())
      return isCurrent()
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  const node = definition?.nodes.find(candidate => candidate.id === selected)
  return (
    <aside
      data-testid="workflow-conversation-canvas"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-background lg:max-w-[50%]"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {definition?.title || t('workflowCanvas.heading')}
        </h2>
        {definition && (
          <span className="text-xs text-text-muted">
            r{definition.revision}
            {definition.savedVersion ? ` · v${definition.savedVersion}` : ''}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('workflowCanvas.reload')}
          onClick={() => {
            setError(null)
            setRetry(value => value + 1)
          }}
        >
          <RefreshCw />
        </Button>
        <Button
          size="sm"
          data-testid="workflow-conversation-publish"
          disabled={!definition?.nodes.length || definition?.status === 'saved' || busy || dirty}
          onClick={() =>
            definition &&
            void mutate(() => workflowApi.save(serverId, definitionId, definition.revision))
          }
        >
          <Save />
          {t('workflowCanvas.publish')}
        </Button>
      </header>
      {error && (
        <p role="alert" className="break-words p-3 text-sm text-error">
          {error}
        </p>
      )}
      <p className="px-3 py-2 text-xs text-text-muted">{t('workflowCanvas.conversationHint')}</p>
      {definition && (
        <div className="relative flex min-h-64 flex-1">
          <WorkflowCanvas
            definition={definition}
            selectedId={selected}
            onSelect={setSelected}
            disabled={busy || dirty}
            onMove={(moved, revision) =>
              void mutate(() => workflowApi.upsert(serverId, definitionId, revision, moved))
            }
          />
        </div>
      )}
      {definition && node && (
        <div className="max-h-[45%] overflow-auto border-t border-border p-3">
          <WorkflowNodeEditor
            key={node.id}
            definition={definition}
            node={node}
            busy={busy}
            onDirty={setDirty}
            onSave={(changed, revision) =>
              mutate(() => workflowApi.upsert(serverId, definitionId, revision, changed))
            }
            onDelete={(_id, revision) =>
              mutate(() => workflowApi.remove(serverId, definitionId, revision, node.id))
            }
          />
        </div>
      )}
    </aside>
  )
}
