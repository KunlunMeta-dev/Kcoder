import { startWorkflowPolling } from './workflowPolling'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowNodeEditor } from './WorkflowNodeEditor'
import { newerDefinition, workflowApi, type WorkflowDefinition } from './workflowApi'

export function WorkflowConversationCanvas({
  serverId,
  definitionId,
  active = true,
  onClose,
  onDirtyChange,
  onOpenAgent,
}: {
  serverId: string
  definitionId: string
  active?: boolean
  onClose?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void
}) {
  const scope = usePluginTargetScope(serverId)
  return (
    <ConversationCanvas
      key={`${scope.key}:${definitionId}`}
      serverId={serverId}
      definitionId={definitionId}
      isCurrent={scope.isCurrent}
      active={active}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      onOpenAgent={onOpenAgent}
    />
  )
}

function ConversationCanvas({
  serverId,
  definitionId,
  isCurrent,
  active,
  onClose,
  onDirtyChange,
  onOpenAgent,
}: {
  serverId: string
  definitionId: string
  isCurrent: () => boolean
  active: boolean
  onClose?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onOpenAgent?: (agentId: string, context?: { runId: string; nodeId: string }) => void
}) {
  const { t } = useTranslation('common')
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const latestDefinition = useRef<WorkflowDefinition | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const setDirty = useCallback(
    (value: boolean) => {
      setDirtyState(value)
      onDirtyChange?.(value)
    },
    [onDirtyChange]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [stale, setStale] = useState(false)
  const apply = useCallback(
    (next: WorkflowDefinition) => {
      if (isCurrent()) {
        latestDefinition.current = newerDefinition(latestDefinition.current, next)
        setDefinition(latestDefinition.current)
      }
    },
    [isCurrent]
  )
  useEffect(
    () =>
      startWorkflowPolling({
        active,
        isCurrent,
        changes: { serverId, definitionId },
        poll: async (isLive, signal) => {
          const next = await workflowApi.read(serverId, definitionId, latestDefinition.current, {
            signal,
          })
          if (!isLive()) return false
          apply(next)
          setError(null)
          setStale(false)
          return next.status === 'saved' ? 10_000 : 3000
        },
        onError: failure => {
          setError(failure instanceof Error ? failure.message : String(failure))
          setStale(true)
        },
      }),
    [serverId, definitionId, isCurrent, apply, retry, active]
  )
  const mutate = async (action: () => Promise<WorkflowDefinition>) => {
    if (stale || !isCurrent()) return false
    setBusy(true)
    setError(null)
    try {
      apply(await action())
      if (isCurrent())
        window.dispatchEvent(
          new CustomEvent('kcoder:workflow-definition-changed', {
            detail: { serverId, id: definitionId },
          })
        )
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
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-background"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {definition?.title || t('workflowCanvas.heading')}
        </h2>
        {definition && (
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-text-muted"
            title={`r${definition.revision}`}
          >
            {definition.status === 'saved'
              ? t('workflowFlow.savedVersion', { version: definition.savedVersion })
              : t('workflowFlow.unsaved')}
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
          title={t('workflowFlow.publishHint')}
          disabled={
            !definition?.nodes.length || definition?.status === 'saved' || busy || dirty || stale
          }
          onClick={() =>
            definition &&
            void mutate(() => workflowApi.save(serverId, definitionId, definition.revision))
          }
        >
          <Save />
          {t('workflowCanvas.publish')}
        </Button>
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            disabled={dirty}
            title={dirty ? t('workflowFlow.finishEdit') : undefined}
            aria-label={t('workflowFlow.closeCanvas')}
            data-testid="workflow-canvas-close"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>
      {stale && (
        <p role="status" className="px-3 py-2 text-xs text-text-secondary">
          {t('workflowFlow.reconnecting')}
        </p>
      )}
      {dirty && (
        <p role="status" className="px-3 py-2 text-xs text-text-secondary">
          {t('workflowFlow.localEdits')}
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="px-3 py-2 text-xs text-text-muted">{t('workflowCanvas.conversationHint')}</p>
      {definition && (
        <div className="relative flex min-h-64 flex-1">
          <WorkflowCanvas
            definition={definition}
            selectedId={selected}
            onOpenAgent={onOpenAgent}
            stale={stale}
            onSelect={setSelected}
            disabled={busy || dirty || stale}
            onMove={(moved, _revision, previous) =>
              void mutate(() => workflowApi.move(serverId, definitionId, moved, previous))
            }
          />
        </div>
      )}
      {definition && node && (
        <div className="max-h-[45%] overflow-auto border-t border-border p-3">
          <WorkflowNodeEditor
            serverId={serverId}
            key={node.id}
            definition={definition}
            node={node}
            busy={busy || stale}
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
