import { useEffect, useState } from 'react'
import { GitBranch, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { WorkflowArguments } from './WorkflowArguments'
import {
  argumentFields,
  argumentIssues,
  defaultArguments,
  parseArguments,
} from './workflowArguments'
import { workflowApi, type WorkflowDefinition, type WorkflowSummary } from './workflowApi'

export function WorkflowReusePicker({
  serverId,
  disabled,
  onInsert,
}: {
  serverId: string
  disabled: boolean
  onInsert: (text: string) => void
}) {
  const scope = usePluginTargetScope(serverId)
  return (
    <ScopedPicker
      key={scope.key}
      serverId={serverId}
      disabled={disabled}
      onInsert={onInsert}
      isCurrent={scope.isCurrent}
    />
  )
}
function ScopedPicker({
  serverId,
  disabled,
  onInsert,
  isCurrent,
}: {
  serverId: string
  disabled: boolean
  onInsert: (text: string) => void
  isCurrent: () => boolean
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        data-testid="workflow-reuse-open"
        onClick={() => setOpen(true)}
      >
        <GitBranch />
        {t('workflowReuse.open')}
      </Button>
      {open && !disabled && (
        <Picker
          serverId={serverId}
          isCurrent={isCurrent}
          onClose={() => setOpen(false)}
          onInsert={text => {
            if (!isCurrent()) return
            onInsert(text)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}
function Picker({
  serverId,
  isCurrent,
  onClose,
  onInsert,
}: {
  serverId: string
  isCurrent: () => boolean
  onClose: () => void
  onInsert: (text: string) => void
}) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<WorkflowSummary[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<WorkflowSummary | null>(null)
  const [versions, setVersions] = useState<
    Array<{ version: number; title: string; nodeCount: number }>
  >([])
  const [version, setVersion] = useState('')
  const [args, setArgs] = useState('{}')
  const [snapshot, setSnapshot] = useState<{ key: string; definition: WorkflowDefinition } | null>(
    null
  )
  const [parametersOpen, setParametersOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let stopped = false
    void (async () => {
      const all: WorkflowSummary[] = []
      let offset = 0
      for (;;) {
        const page = await workflowApi.list(serverId, offset)
        if (stopped || !isCurrent()) return
        all.push(...page.items)
        if (page.nextOffset == null) break
        if (page.nextOffset <= offset || all.length >= 256)
          throw new Error(t('workflowReuse.listLimit'))
        offset = page.nextOffset
      }
      setItems(all.filter(item => (item.savedVersion ?? 0) > 0))
    })()
      .catch(failure => {
        if (!stopped && isCurrent())
          setError(String(failure instanceof Error ? failure.message : failure))
      })
      .finally(() => {
        if (!stopped && isCurrent()) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [serverId, isCurrent, retry, t])
  useEffect(() => {
    if (!selected) return
    let stopped = false
    void workflowApi
      .versions(serverId, selected.id)
      .then(result => {
        if (stopped || !isCurrent()) return
        const sorted = [...result].sort((a, b) => b.version - a.version)
        setVersions(sorted)
        setVersion(sorted[0] ? String(sorted[0].version) : '')
      })
      .catch(failure => {
        if (!stopped && isCurrent())
          setError(String(failure instanceof Error ? failure.message : failure))
      })
    return () => {
      stopped = true
    }
  }, [serverId, selected, isCurrent])
  const snapshotKey = selected && version ? `${selected.id}:${version}` : ''
  const definition = snapshot?.key === snapshotKey ? snapshot.definition : null
  useEffect(() => {
    if (!selected || !version) return
    let stopped = false
    void workflowApi
      .exportDefinition(serverId, selected.id, Number(version))
      .then(definition => {
        if (stopped || !isCurrent()) return
        if (definition.id !== selected.id || definition.savedVersion !== Number(version))
          throw new Error(t('workflowReuse.versionMismatch'))
        setSnapshot({ key: `${selected.id}:${version}`, definition })
        setArgs(defaultArguments(argumentFields(definition.inputSchema)))
      })
      .catch(failure => {
        if (!stopped && isCurrent())
          setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      stopped = true
    }
  }, [serverId, selected, version, isCurrent, t])
  const parsed = parseArguments(args)
  const issues =
    definition && parsed
      ? argumentIssues(argumentFields(definition.inputSchema), parsed, definition.inputSchema)
      : []
  const insert = () => {
    if (!selected || !definition || !isCurrent()) return
    if (parametersOpen && (!parsed || issues.length)) {
      setError(t('workflowReuse.fixParameters'))
      return
    }
    onInsert(
      t('workflowReuse.conversationInstruction', {
        title: definition.title,
        params: JSON.stringify({
          definition_id: selected.id,
          version: Number(version),
          ...(parametersOpen ? { args: parsed } : {}),
        }),
      })
    )
  }
  const shown = items.filter(item =>
    `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  return (
    <ModalDialog title={t('workflowReuse.open')} testId="workflow-reuse-picker" onClose={onClose}>
      <p className="my-3 text-sm text-text-secondary">{t('workflowReuse.hint')}</p>
      <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
        <Search className="h-4 w-4 text-text-muted" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          value={query}
          aria-label={t('workflowReuse.search')}
          placeholder={t('workflowReuse.search')}
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      <div className="my-3 max-h-64 space-y-1 overflow-y-auto">
        {loading && (
          <p role="status" className="p-3 text-sm text-text-muted">
            {t('workflowReuse.loading')}
          </p>
        )}
        {!loading && !error && !shown.length && (
          <p className="p-3 text-sm text-text-muted">{t('workflowReuse.empty')}</p>
        )}
        {shown.map(item => (
          <button
            type="button"
            key={item.id}
            data-testid={`workflow-reuse-${item.id}`}
            aria-pressed={selected?.id === item.id}
            onClick={() => {
              if (selected?.id === item.id) return
              setSelected(item)
              setVersions([])
              setVersion('')
              setError(null)
              setArgs('{}')
              setSnapshot(null)
              setParametersOpen(false)
            }}
            className="w-full rounded-lg border border-transparent p-3 text-left hover:bg-surface aria-pressed:border-border aria-pressed:bg-surface"
          >
            <span className="block truncate text-sm font-medium">{item.title}</span>
            <span className="block truncate text-xs text-text-muted">
              {item.description || t('workflowReuse.saved')} · v{item.savedVersion}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="space-y-3 border-t border-border pt-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('workflowCanvas.version')}
            <select
              data-testid="workflow-reuse-version"
              value={version}
              disabled={!versions.length}
              onChange={event => {
                setVersion(event.target.value)
                setError(null)
                setSnapshot(null)
                setParametersOpen(false)
              }}
              className="rounded-lg border border-border bg-background px-3 py-2"
            >
              {!versions.length && <option value="">{t('workflowReuse.loading')}</option>}
              {versions.map(item => (
                <option key={item.version} value={item.version}>
                  v{item.version} · {item.title} · {item.nodeCount}
                </option>
              ))}
            </select>
          </label>
          {!definition && !error && (
            <p role="status" className="text-sm text-text-muted">
              {t('workflowReuse.loadingVersion')}
            </p>
          )}
          {definition && (
            <>
              <div
                data-testid="workflow-reuse-preview"
                className="space-y-2 rounded-lg bg-surface p-3"
              >
                <p className="text-sm font-medium">
                  {definition.title} · v{definition.savedVersion}
                </p>
                {definition.description && (
                  <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">
                    {definition.description}
                  </p>
                )}
                <details className="text-xs text-text-muted">
                  <summary className="cursor-pointer">
                    {t('workflowReuse.previewNodes', { count: definition.nodes.length })}
                  </summary>
                  <ol className="mt-2 space-y-1">
                    {definition.nodes.map(node => (
                      <li key={node.id}>
                        {node.title || node.id} · {t(`workflowCanvas.kind_${node.kind ?? 'agent'}`)}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
              <p className="text-sm text-text-secondary">{t('workflowReuse.conversationHint')}</p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={parametersOpen}
                  onClick={() => setParametersOpen(value => !value)}
                  data-testid="workflow-reuse-parameters-toggle"
                  className="cursor-pointer text-sm"
                >
                  {t('workflowReuse.optionalParameters')}
                </Button>
                {parametersOpen && (
                  <div className="mt-3">
                    <WorkflowArguments
                      key={snapshotKey}
                      schema={definition.inputSchema}
                      value={args}
                      onChange={text => {
                        setArgs(text)
                        setError(null)
                      }}
                    />
                    {!parsed && (
                      <p role="alert" className="mt-2 text-sm text-error">
                        {t('workflowReuse.objectRequired')}
                      </p>
                    )}
                    {issues.map((issue, index) => (
                      <p key={index} role="alert" className="mt-2 text-sm text-error">
                        {t(`workflowReuse.issue_${issue.reason}`, {
                          field: issue.field,
                          limit: issue.limit,
                        })}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="my-3 break-words text-sm text-error">
          {error}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLoading(true)
              setError(null)
              setItems([])
              setSelected(null)
              setVersions([])
              setVersion('')
              setRetry(value => value + 1)
            }}
          >
            {t('workflowCanvas.reload')}
          </Button>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X />
          {t('workflowReuse.close')}
        </Button>
        <Button
          size="sm"
          disabled={!definition || loading}
          data-testid="workflow-reuse-insert"
          onClick={insert}
        >
          {t('workflowReuse.insert')}
        </Button>
      </div>
    </ModalDialog>
  )
}
