import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkflowDefinition, WorkflowNode } from './workflowApi'
const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-focus/30'
const textFields = (node: WorkflowNode) => ({
  allowedWritePaths: node.allowedWritePaths.join('\n'),
  acceptanceCriteria: node.acceptanceCriteria.join('\n'),
  expectedArtifacts: node.expectedArtifacts.join('\n'),
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
          {['general', 'explore', 'plan', 'review', 'implementer', 'verifier', 'tool_agent'].map(
            role => (
              <option key={role} value={role}>
                {role}
              </option>
            )
          )}
          {![
            'general',
            'explore',
            'plan',
            'review',
            'implementer',
            'verifier',
            'tool_agent',
          ].includes(draft.agentType) && <option value={draft.agentType}>{draft.agentType}</option>}
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
        disabled={busy || !dirty || stale}
        onClick={() =>
          void onSave(
            {
              ...draft,
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
            onDirty(false)
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
