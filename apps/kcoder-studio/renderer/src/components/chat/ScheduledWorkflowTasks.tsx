import type { ScheduledWorkflowChoice } from './createScheduledWorkflowTask'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/host/localExecutor'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'
import {
  KnowledgeIntegrationClient,
  KnowledgeOperationError,
} from '@/features/knowledge-integration/client'
import { OperationError } from '@/features/knowledge-integration/shared'
import type { SavedBusinessWorkflow } from '@/features/knowledge-integration/BusinessSubscriptions'
import { nativeAutomationWorkflows } from '@/features/runtime-governance/nativeAutomationWorkflows'
import { nativeKnowledgeTransport } from '@/features/runtime-governance/knowledgeTransport'
import { NativeKnowledgeContent } from '@/features/runtime-governance/NativeKnowledgeContent'
import { workflowApi, type WorkflowDefinition } from '@/features/workflows/workflowApi'
import { argumentFields, defaultArguments } from '@/features/workflows/workflowInputArguments'

/** One selected target owns saved-version selection, subscriptions and the original inbox. */
export function ScheduledWorkflowTasks({
  serverId,
  workspacePath,
  view,
  onBlockedChange,
  suspended = false,
  onCreated,
  selectionOnly = false,
  onChoiceChange,
}: {
  serverId: string
  workspacePath: string
  view: 'create' | 'manage' | 'inbox'
  selectionOnly?: boolean
  onChoiceChange?: (choice: ScheduledWorkflowChoice | null) => void
  onCreated?: () => void
  suspended?: boolean
  onBlockedChange?: (blocked: boolean) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const scope = usePluginTargetScope(serverId, workspacePath)
  const { isCurrent: scopeCurrent } = scope
  const [builtinChoice, setBuiltinChoice] = useState<{ owner: string; open: boolean }>()
  const builtinOpen = builtinChoice?.owner === scope.key && builtinChoice.open
  const [refreshing, setRefreshing] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const reportBlocked = useCallback(
    (value: boolean) => {
      setBlocked(value)
      onBlockedChange?.(value)
    },
    [onBlockedChange]
  )
  const [revision, setRevision] = useState(0)
  const [catalog, setCatalog] = useState<{
    key: string
    items: SavedBusinessWorkflow[]
    error?: KnowledgeOperationError
  }>()
  const [binding, setBinding] = useState<{
    key: string
    client: KnowledgeIntegrationClient
    error?: KnowledgeOperationError
  }>()
  const [failure, setFailure] = useState<{ key: string; value: KnowledgeOperationError }>()
  const [selectedChoice, setSelectedChoice] = useState<{ owner: string; value: string }>()
  const selection = selectedChoice?.owner === scope.key ? selectedChoice.value : ''
  const [definition, setDefinition] = useState<{ key: string; value: WorkflowDefinition }>()
  const key = scope.key
  const current = useRef(key)
  useLayoutEffect(() => {
    current.current = key
  }, [key])
  const isCurrent = useCallback(
    () => current.current === key && scopeCurrent(),
    [key, scopeCurrent]
  )
  const reconnect = useCallback(() => {
    setRefreshing(true)
    setRevision(value => value + 1)
  }, [])
  useEffect(() => {
    const cancel = new AbortController()
    let owned: KnowledgeIntegrationClient | undefined
    void nativeAutomationWorkflows(serverId, isCurrent, cancel.signal, workspacePath)
      .then(items => {
        if (!cancel.signal.aborted && isCurrent()) setCatalog({ key, items })
      })
      .catch(() => {
        if (!cancel.signal.aborted && isCurrent())
          setCatalog({
            key,
            items: [],
            error: new KnowledgeOperationError('AUTOMATION_WORKFLOW_UNAVAILABLE'),
          })
      })
    void requestLocalExecutor<unknown>(
      'runtime.integrations.request',
      { serverId, workspacePath, method: 'integrations/scope/read', params: {} },
      { signal: cancel.signal }
    )
      .then(value => {
        if (cancel.signal.aborted || !isCurrent()) return
        if (!isIntegrationScope(value))
          throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
        owned = new KnowledgeIntegrationClient(
          value,
          nativeKnowledgeTransport({ serverId, workspacePath })
        )
        setBinding({ key, client: owned })
        setRefreshing(false)
        setFailure(undefined)
      })
      .catch(() => {
        if (!cancel.signal.aborted && isCurrent()) {
          setRefreshing(true)
          setFailure({
            key,
            value: new KnowledgeOperationError('KNOWLEDGE_CONNECTION_UNAVAILABLE'),
          })
        }
      })
    return () => {
      cancel.abort()
      owned?.dispose()
    }
  }, [serverId, workspacePath, key, isCurrent, revision])
  const workflows = catalog?.key === key ? catalog.items : []
  const selected = workflows.find(item => JSON.stringify([item.id, item.version]) === selection)
  const selectedKey = selected ? JSON.stringify([key, selected.id, selected.version]) : ''
  useEffect(() => {
    if (!selected) return
    const cancel = new AbortController()
    void workflowApi
      .exportDefinition(serverId, selected.id, selected.version, {
        signal: cancel.signal,
        workspacePath,
      })
      .then(value => {
        if (cancel.signal.aborted || !isCurrent()) return
        if (value.id !== selected.id || value.savedVersion !== selected.version)
          throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
        setDefinition({ key: selectedKey, value })
        setFailure(undefined)
      })
      .catch(() => {
        if (!cancel.signal.aborted && isCurrent())
          setFailure({ key, value: new KnowledgeOperationError('AUTOMATION_WORKFLOW_UNAVAILABLE') })
      })
    return () => cancel.abort()
  }, [serverId, workspacePath, selected, selectedKey, key, isCurrent])
  const client = binding?.key === key ? binding.client : undefined
  const snapshot = definition?.key === selectedKey ? definition.value : undefined
  useEffect(() => {
    if (!selectionOnly || !onChoiceChange) return
    onChoiceChange(selected && snapshot ? {
      id: selected.id, version: selected.version, title: selected.title,
      definition: snapshot, isCurrent,
    } : null)
    return () => onChoiceChange(null)
  }, [selectionOnly, onChoiceChange, selected, snapshot, isCurrent])
  return (
    <fieldset disabled={suspended} className="space-y-4" data-testid="scheduled-workflow-tasks">
      <legend className="sr-only">{t('runSavedWorkflow')}</legend>
      {view === 'create' && (
        <div>
          <SettingsSelect
            aria-label={t('chooseSavedWorkflow')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            surfaceClassName="min-h-11 rounded-lg shadow-none"
            value={selected ? selection : ''}
            disabled={blocked}
            onChange={event => setSelectedChoice({ owner: scope.key, value: event.target.value })}
            data-testid="scheduled-workflow-choice"
          >
            <option value="">{t('chooseSavedWorkflow')}</option>
            {workflows.map(item => (
              <option
                key={`${item.id}@${item.version}`}
                value={JSON.stringify([item.id, item.version])}
              >
                {item.title} · v{item.version}
              </option>
            ))}
          </SettingsSelect>
        </div>
      )}
      {catalog?.key === key && !catalog.error && workflows.length === 0 && view === 'create' && (
        <p>{t('noSavedWorkflows')}</p>
      )}
      {(failure?.key === key || (catalog?.key === key && catalog.error)) && (
        <>
          <OperationError error={failure?.key === key ? failure.value : catalog?.error} />
          <Button variant="outline" onClick={reconnect}>
            {t('refresh')}
          </Button>
        </>
      )}
      {view === 'create' && !selectionOnly && (
        <Button
          type="button"
          variant="ghost"
          disabled={blocked}
          aria-expanded={builtinOpen}
          data-testid="scheduled-builtin-templates"
          onClick={() => setBuiltinChoice({ owner: scope.key, open: !builtinOpen })}
        >
          {t('builtinWorkflowTemplates')}
        </Button>
      )}
      {!selectionOnly && client && (view !== 'create' || builtinOpen || (selected && snapshot)) && (
        <fieldset disabled={refreshing} className="min-w-0">
          <legend className="sr-only">{t('runSavedWorkflow')}</legend>
          {
            <NativeKnowledgeContent
              key={`${client.ownerKey}:${view}:${selectedKey}`}
              client={client}
              serverId={serverId}
              workspacePath={workspacePath}
              isCurrent={isCurrent}
              onReconnect={reconnect}
              automationOnly
              includeBuiltinTemplates={builtinOpen}
              automationView={view}
              savedWorkflows={workflows}
              creationWorkflow={view === 'create' && !builtinOpen ? selected : undefined}
              workflowSchema={snapshot?.inputSchema}
              onCreationBlocked={reportBlocked}
              onCreated={onCreated}
              workflowInputs={
                snapshot ? defaultArguments(argumentFields(snapshot.inputSchema)) : undefined
              }
            />
          }
        </fieldset>
      )}
    </fieldset>
  )
}
