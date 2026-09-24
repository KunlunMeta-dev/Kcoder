import { WorkflowNodeConfigFields } from './WorkflowNodeConfigFields'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeKind } from './workflowApi'
const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30'
const textFields = (node: WorkflowNode) => ({
  allowedWritePaths: node.allowedWritePaths.join('\n'),
  acceptanceCriteria: node.acceptanceCriteria.join('\n'),
  expectedArtifacts: node.expectedArtifacts.join('\n'),
  config: JSON.stringify(node.config ?? {}, null, 2),
})
const lines = (value: string) =>
  value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
export function WorkflowNodeEditor({
  definition,
  node,
  busy,
  onSave,
  onDelete,
  onDirty,
}: {
  definition: WorkflowDefinition
  node: WorkflowNode
  busy: boolean
  onDirty: (dirty: boolean) => void
  onSave: (node: WorkflowNode, revision: number) => Promise<boolean>
  onDelete: (id: string, revision: number) => Promise<boolean>
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState(node)
  const [advanced, setAdvanced] = useState(() => textFields(node))
  const [baseRevision, setBaseRevision] = useState(definition.revision)
  const [dirty, setDirty] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const update = (patch: Partial<WorkflowNode>) => {
    setDraft(current => ({ ...current, ...patch }))
    setDirty(true)
    onDirty(true)
  }
  if (!dirty && baseRevision !== definition.revision) {
    setDraft(node)
    setAdvanced(textFields(node))
    setBaseRevision(definition.revision)
  }
  const kind = draft.kind ?? 'agent'
  let parsedConfig: Record<string, unknown> = {}
  let configError = false
  try {
    const parsed: unknown = JSON.parse(advanced.config)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('object required')
    parsedConfig = parsed as Record<string, unknown>
  } catch {
    configError = true
  }
  const stale = baseRevision !== definition.revision
  return (
    <aside
      data-testid="workflow-node-editor"
      className="w-full shrink-0 space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-4 md:w-72"
    >
      <h2 className="text-sm font-medium">{t('workflowCanvas.nodeDetails')}</h2>
      <p className="break-all text-xs text-text-muted">{node.id}</p>
      {stale && (
        <div role="status" className="space-y-2 text-xs text-text-secondary">
          <p>{t('workflowCanvas.editorStale')}</p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="workflow-node-reload"
            onClick={() => {
              setDraft(node)
              setAdvanced(textFields(node))
              setBaseRevision(definition.revision)
              setDirty(false)
              onDirty(false)
            }}
          >
            {t('workflowCanvas.reloadNode')}
          </Button>
        </div>
      )}
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.title')}
        <input
          data-testid="workflow-node-title"
          className={inputClass}
          value={draft.title}
          onChange={event => update({ title: event.target.value })}
          maxLength={512}
        />
      </label>
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.nodeType')}
        <select
          data-testid="workflow-node-kind"
          className={inputClass}
          value={kind}
          onChange={event => {
            const next = event.target.value as WorkflowNodeKind
            const defaults: Record<WorkflowNodeKind, Record<string, unknown>> = {
              agent: {},
              input: { pointer: '/input' },
              output: { pointer: '/input' },
              template: { template: '{{/input}}' },
              condition: { condition: { op: 'exists', pointer: '/input' } },
              merge: { mergePolicy: 'all' },
              loop: { loop: { mode: 'repeat', maxIterations: 3 } },
            }
            update({ kind: next, config: defaults[next] })
            setAdvanced(current => ({
              ...current,
              config: JSON.stringify(defaults[next], null, 2),
            }))
          }}
        >
          {(['agent', 'input', 'template', 'condition', 'merge', 'loop', 'output'] as const).map(
            value => (
              <option key={value} value={value}>
                {t(`workflowCanvas.kind_${value}`)}
              </option>
            )
          )}
        </select>
      </label>
      {(kind === 'agent' || kind === 'loop') && (
        <>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.prompt')}
            <textarea
              data-testid="workflow-node-prompt"
              className={inputClass}
              rows={5}
              value={draft.prompt}
              onChange={event => update({ prompt: event.target.value })}
              maxLength={16384}
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.role')}
            <select
              data-testid="workflow-node-role"
              className={inputClass}
              value={draft.agentType}
              onChange={event => update({ agentType: event.target.value })}
            >
              {[
                'general',
                'explore',
                'plan',
                'review',
                'implementer',
                'verifier',
                'tool_agent',
              ].map(role => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
              {![
                'general',
                'explore',
                'plan',
                'review',
                'implementer',
                'verifier',
                'tool_agent',
              ].includes(draft.agentType) && (
                <option value={draft.agentType}>{draft.agentType}</option>
              )}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            {t('workflowCanvas.maxTurns')}
            <input
              className={inputClass}
              type="number"
              min={1}
              max={100}
              value={draft.maxTurns}
              onChange={event => update({ maxTurns: Number(event.target.value) })}
            />
          </label>
        </>
      )}
      {!configError && (
        <WorkflowNodeConfigFields
          kind={kind}
          config={parsedConfig}
          node={draft}
          definition={definition}
          onChange={config => {
            update({ config })
            setAdvanced(current => ({ ...current, config: JSON.stringify(config, null, 2) }))
          }}
        />
      )}
      <details>
        <summary className="cursor-pointer text-sm">{t('workflowCanvas.nodeConfig')}</summary>
        <p className="my-2 text-xs text-text-muted">{t('workflowCanvas.nodeConfigHint')}</p>
        <textarea
          data-testid="workflow-node-config"
          aria-label={t('workflowCanvas.nodeConfig')}
          className={`${inputClass} font-mono`}
          rows={7}
          value={advanced.config}
          onChange={event => {
            setAdvanced(current => ({ ...current, config: event.target.value }))
            setDirty(true)
            onDirty(true)
          }}
        />
        {configError && (
          <p role="alert" className="text-xs text-destructive">
            {t('workflowCanvas.invalidJsonObject')}
          </p>
        )}
      </details>
      <label className="block space-y-1 text-sm">
        {t('workflowCanvas.runIf')}
        <select
          className={inputClass}
          value={draft.runIf?.nodeId ?? ''}
          onChange={event => {
            const nodeId = event.target.value
            update({
              runIf: nodeId ? { nodeId, equals: true } : undefined,
              dependsOn:
                nodeId && !draft.dependsOn.includes(nodeId)
                  ? [...draft.dependsOn, nodeId]
                  : draft.dependsOn,
            })
          }}
        >
          <option value="">{t('workflowCanvas.always')}</option>
          {definition.nodes
            .filter(candidate => candidate.id !== node.id && candidate.kind === 'condition')
            .map(candidate => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title || candidate.id}
              </option>
            ))}
        </select>
      </label>
      {draft.runIf && (
        <select
          aria-label={t('workflowCanvas.branchValue')}
          className={inputClass}
          value={String(draft.runIf.equals)}
          onChange={event =>
            update({ runIf: { ...draft.runIf!, equals: event.target.value === 'true' } })
          }
        >
          <option value="true">{t('workflowCanvas.trueBranch')}</option>
          <option value="false">{t('workflowCanvas.falseBranch')}</option>
        </select>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm">{t('workflowCanvas.dependencies')}</legend>
        {definition.nodes
          .filter(candidate => candidate.id !== node.id)
          .map(candidate => (
            <label className="flex items-center gap-2 text-sm" key={candidate.id}>
              <Checkbox
                checked={draft.dependsOn.includes(candidate.id)}
                onChange={event =>
                  update({
                    dependsOn: event.target.checked
                      ? [...draft.dependsOn, candidate.id]
                      : draft.dependsOn.filter(id => id !== candidate.id),
                  })
                }
              />
              <span className="truncate">{candidate.title || candidate.id}</span>
            </label>
          ))}
        {draft.dependsOn
          .filter(id => !definition.nodes.some(candidate => candidate.id === id))
          .map(id => (
            <label key={id} className="flex items-center gap-2 text-sm text-destructive">
              <Checkbox
                checked
                onChange={() =>
                  update({ dependsOn: draft.dependsOn.filter(value => value !== id) })
                }
              />
              {id} ({t('workflowCanvas.missingNode')})
            </label>
          ))}
      </fieldset>
      <details>
        <summary className="cursor-pointer text-sm">{t('workflowCanvas.advanced')}</summary>
        <div className="mt-3 space-y-3">
          {(['allowedWritePaths', 'acceptanceCriteria', 'expectedArtifacts'] as const).map(
            field => (
              <label className="block space-y-1 text-sm" key={field}>
                {t(`workflowCanvas.${field}`)}
                <textarea
                  className={inputClass}
                  rows={3}
                  value={advanced[field]}
                  onChange={event => {
                    setAdvanced(current => ({ ...current, [field]: event.target.value }))
                    setDirty(true)
                    onDirty(true)
                  }}
                />
              </label>
            )
          )}
        </div>
      </details>
      {dirty && (
        <Button
          className="w-full"
          variant="secondary"
          data-testid="workflow-node-discard"
          onClick={() => {
            setDraft(node)
            setAdvanced(textFields(node))
            setBaseRevision(definition.revision)
            setDirty(false)
            onDirty(false)
          }}
        >
          {t('workflowCanvas.discardEdits')}
        </Button>
      )}
      <Button
        className="w-full"
        data-testid="workflow-node-save"
        disabled={busy || !dirty || stale || configError}
        onClick={() =>
          void onSave(
            {
              ...draft,
              config: parsedConfig,
              allowedWritePaths: lines(advanced.allowedWritePaths),
              acceptanceCriteria: lines(advanced.acceptanceCriteria),
              expectedArtifacts: lines(advanced.expectedArtifacts),
            },
            baseRevision
          ).then(ok => {
            if (ok) {
              setDirty(false)
              onDirty(false)
            }
          })
        }
      >
        {t('workflowCanvas.applyNode')}
      </Button>
      <Button
        className="w-full"
        variant="ghost"
        data-testid="workflow-node-delete"
        disabled={busy || stale}
        onClick={() => setConfirmDelete(true)}
      >
        {t('workflowCanvas.deleteNode')}
      </Button>
      {confirmDelete && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{t('workflowCanvas.deleteConfirm')}</p>
          <Button
            variant="destructive"
            data-testid="workflow-node-delete-confirm"
            disabled={busy || stale}
            onClick={() => void onDelete(node.id, baseRevision)}
          >
            {t('workflowCanvas.deleteNode')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('workflowCanvas.cancel')}
          </Button>
        </div>
      )}
    </aside>
  )
}
