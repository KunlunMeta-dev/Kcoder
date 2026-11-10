import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Select, Spin, Switch } from 'antd'
import { RefreshCw, Search, Wrench } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { readToolSelections } from '@/kcoder/toolSelections'
import { ToolSelectionResolution } from '@/components/settings/ToolSelectionResolution'
import type {
  OfficeAssistantDraft,
  OfficeAssistantDefinition,
  OfficeAssistantVersion,
  ToolSelectionsResult,
} from '../../../../shared/generated/contracts'
import type { OfficeAssistantItem } from '@/features/office-integration/controller'
import type { ExpertClient } from './client'
import { isContract } from '../../../../shared/generated/validator.mjs'

/** Edits the actual target-owned expert draft using the selected project's catalog. */
export function ExpertToolsWorkspace({
  client,
  item,
  onSaved,
}: {
  client: ExpertClient
  item: OfficeAssistantItem
  onSaved: (draft: OfficeAssistantDraft) => void
}) {
  const { t } = useTranslation('experts')
  const [catalog, setCatalog] = useState<ToolSelectionsResult>()
  const [previewKey, setPreviewKey] = useState('')
  const [previewMode, setPreviewMode] = useState<'kcoder' | 'kworker'>('kcoder')
  const [selection, setSelection] = useState<string[] | null>(item.definition.allowedTools ?? null)
  const [confirmed, setConfirmed] = useState({
    definition: item.definition,
    revision: item.draftRevision,
  })
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<
    'saved' | 'published' | 'publishFailed' | 'failed' | 'pending' | 'loadFailed'
  >()
  const lifetime = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const baselineKnown = Array.isArray(catalog?.lunaAllowedTools)
  const independent = catalog?.expertToolsIndependent === true
  const defaults = catalog?.lunaAllowedTools ?? []
  const selected = selection ?? defaults
  const target = client.target
  const changed =
    JSON.stringify(selection) !== JSON.stringify(confirmed.definition.allowedTools ?? null)
  const pending = !!client.pending()
  const requestedPreviewKey = JSON.stringify({ ...confirmed.definition, allowedTools: selection })
  useEffect(() => {
    const owner = new AbortController()
    lifetime.current = owner
    queueMicrotask(() => {
      if (!owner.signal.aborted) setCatalog(undefined)
    })
    return () => {
      owner.abort()
      lifetime.current = null
    }
  }, [target])
  useEffect(() => {
    const owner = new AbortController()
    void (async () => {
      await Promise.resolve()
      owner.signal.throwIfAborted()
      setLoading(true)
      setPreviewKey('')
      if (!target?.serverId || !target.workspacePath) throw new Error('EXPERT_PROJECT_REQUIRED')
      const result = await readToolSelections(
        target.serverId,
        target.workspacePath,
        true,
        JSON.parse(requestedPreviewKey) as OfficeAssistantDefinition
      )
      owner.signal.throwIfAborted()
      setCatalog(result)
      setPreviewKey(requestedPreviewKey)
    })()
      .catch(() => {
        if (!owner.signal.aborted) {
          setNotice('loadFailed')
        }
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false)
      })
    return () => {
      owner.abort()
    }
  }, [target, reload, requestedPreviewKey])

  const act = async (publish: boolean, nextSelection = selection) => {
    const owner = lifetime.current
    if (
      !owner ||
      lock.current ||
      !catalog ||
      !baselineKnown ||
      catalog.truncated ||
      client.pending()
    )
      return
    lock.current = true
    setSelection(nextSelection)
    setBusy(true)
    setNotice(undefined)
    const needsSave =
      JSON.stringify(nextSelection) !== JSON.stringify(confirmed.definition.allowedTools ?? null)
    let draftSaved = !needsSave
    try {
      let draft: OfficeAssistantDraft | undefined
      if (needsSave) {
        draft = await client.save(
          { ...confirmed.definition, allowedTools: nextSelection },
          confirmed.revision,
          owner.signal
        )
        owner.signal.throwIfAborted()
        if (
          draft.definition.id !== item.definition.id ||
          JSON.stringify(draft.definition.allowedTools ?? null) !== JSON.stringify(nextSelection)
        )
          throw new Error('EXPERT_DRAFT_UNCONFIRMED')
        setConfirmed(draft)
        onSaved(draft)
        draftSaved = true
      }
      if (publish) {
        const result = await client.mutate(
          'assistant/saveVersion',
          { id: item.definition.id, version: version.trim() },
          owner.signal,
          draft?.revision ?? confirmed.revision
        )
        owner.signal.throwIfAborted()
        const saved = result.saved as OfficeAssistantVersion | undefined
        if (
          !saved ||
          !isContract('OfficeAssistantVersion', saved) ||
          saved.definition.id !== item.definition.id ||
          saved.version !== version.trim() ||
          JSON.stringify(saved.definition.allowedTools ?? null) !== JSON.stringify(nextSelection)
        )
          throw new Error('EXPERT_VERSION_UNCONFIRMED')
        setNotice('published')
      } else setNotice('saved')
    } catch {
      if (!owner.signal.aborted)
        setNotice(client.pending() ? 'pending' : publish && draftSaved ? 'publishFailed' : 'failed')
    } finally {
      lock.current = false
      if (!owner.signal.aborted) setBusy(false)
    }
  }
  const refresh = async () => {
    const owner = lifetime.current
    if (!owner || lock.current) return
    if (client.pending() || notice === 'failed') {
      lock.current = true
      setBusy(true)
      try {
        if (client.pending()) await client.reconcile(owner.signal)
        owner.signal.throwIfAborted()
        const result = await client.controller.call<{ draft: OfficeAssistantDraft }>(
          'assistant/read',
          { id: item.definition.id },
          undefined,
          owner.signal
        )
        owner.signal.throwIfAborted()
        if (
          !isContract('OfficeAssistantDraft', result.draft) ||
          result.draft.definition.id !== item.definition.id
        )
          throw new Error('EXPERT_DRAFT_CHANGED')
        onSaved(result.draft)
        setConfirmed(result.draft)
        setSelection(result.draft.definition.allowedTools ?? null)
      } catch {
        if (!owner.signal.aborted) setNotice(client.pending() ? 'pending' : 'failed')
        return
      } finally {
        lock.current = false
        if (!owner.signal.aborted) setBusy(false)
      }
    }
    setLoading(true)
    setNotice(undefined)
    setReload(value => value + 1)
  }
  if (loading && !catalog) return <Spin />
  const resolution =
    previewKey === requestedPreviewKey
      ? catalog?.resolution?.find(mode => mode.mode === previewMode)
      : undefined
  const search = query.trim().toLocaleLowerCase()
  const tools =
    catalog?.tools.filter(tool =>
      `${tool.name} ${tool.ui.displayName} ${tool.ui.description}`
        .toLocaleLowerCase()
        .includes(search)
    ) ?? []
  const pages = Math.max(1, Math.ceil(tools.length / 10))
  const currentPage = Math.min(page, pages)
  return (
    <section
      data-testid="expert-tools-workspace"
      className="octop-personalization-tools space-y-4"
      aria-label={t('personalization.tabs.tools')}
      aria-busy={busy}
      tabIndex={0}
    >
      <p className="text-sm text-text-secondary">{t('toolSettings.explanation')}</p>
      <p className="text-sm text-text-secondary">
        {t(independent ? 'toolSettings.independentPreviewHint' : 'toolSettings.previewHint')}
      </p>
      <p className="break-all text-sm text-text-muted" data-testid="expert-tools-project">
        {target?.workspacePath}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr_auto]">
        <Select
          aria-label={t('toolAccess')}
          value={selection === null ? 'inherit' : 'restricted'}
          disabled={busy || pending || !baselineKnown || !catalog || catalog.truncated}
          onChange={mode => void act(false, mode === 'inherit' ? null : [...selected])}
          options={[
            { value: 'inherit', label: t('inheritTaskTools') },
            { value: 'restricted', label: t('restrictedTools') },
          ]}
        />
        <Input
          aria-label={t('toolSettings.search')}
          placeholder={t('toolSettings.search')}
          prefix={<Search size={14} />}
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setPage(1)
          }}
        />
        <Button disabled={busy} icon={<RefreshCw size={14} />} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-sm text-text-secondary">
          {t('toolSettings.saving')}
        </p>
      )}
      {notice && (
        <Alert
          type={['saved', 'published'].includes(notice) ? 'success' : 'warning'}
          showIcon
          message={t(`toolSettings.${notice}`)}
        />
      )}
      {catalog?.truncated && <Alert type="warning" message={t('toolSettings.truncated')} />}
      {catalog && !baselineKnown && (
        <Alert
          data-testid="expert-tools-baseline-unknown"
          type="warning"
          showIcon
          message={t('toolSettings.baselineUnknown')}
        />
      )}
      <Select
        data-testid="expert-tools-preview-mode"
        aria-label={t('toolSettings.previewMode')}
        value={previewMode}
        onChange={setPreviewMode}
        options={[
          { value: 'kcoder', label: 'KCoder' },
          { value: 'kworker', label: 'KWorker' },
        ]}
      />
      {tools.slice((currentPage - 1) * 10, currentPage * 10).map(tool => {
        const outsideBaseline = !independent && baselineKnown && !defaults.includes(tool.name)
        const unavailable =
          !baselineKnown ||
          outsideBaseline ||
          !tool.available ||
          (independent ? !tool.supportedModes.length : !tool.supportedModes.includes('kcoder'))
        return (
          <div
            key={tool.name}
            data-expert-tool={tool.name}
            className="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <Wrench aria-hidden="true" size={18} className="shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{tool.ui.displayName || tool.name}</p>
              <p
                className="line-clamp-2 break-words text-sm text-text-secondary"
                title={tool.ui.description}
              >
                {tool.ui.description}
              </p>
              <p className="text-sm text-text-muted">
                {tool.name}
                {unavailable
                  ? ` · ${t(!baselineKnown ? 'toolSettings.unconfirmed' : outsideBaseline ? 'toolSettings.outsideBaseline' : 'toolSettings.unavailable')}`
                  : ''}
              </p>
              <ToolSelectionResolution
                configured={
                  selection === null && !baselineKnown ? undefined : selected.includes(tool.name)
                }
                loading={loading}
                backendUnsupported={
                  previewKey === requestedPreviewKey && catalog?.resolution == null
                }
                tool={resolution?.tools.find(item => item.name === tool.name)}
              />
            </div>
            <Switch
              aria-label={tool.ui.displayName || tool.name}
              checked={selected.includes(tool.name)}
              disabled={
                busy ||
                pending ||
                !baselineKnown ||
                (!selected.includes(tool.name) && unavailable) ||
                catalog?.truncated
              }
              onChange={enabled =>
                void act(
                  false,
                  enabled
                    ? [...new Set([...selected, tool.name])]
                    : selected.filter(name => name !== tool.name)
                )
              }
            />
          </div>
        )
      })}
      <nav
        className="flex flex-wrap items-center justify-between gap-3"
        aria-label={t('toolSettings.pagination')}
      >
        <span className="text-sm text-text-secondary">
          {t('toolSettings.page', { page: currentPage, pages, count: tools.length })}
        </span>
        <div className="flex gap-2">
          <Button disabled={currentPage <= 1 || busy} onClick={() => setPage(currentPage - 1)}>
            {t('toolSettings.previous')}
          </Button>
          <Button disabled={currentPage >= pages || busy} onClick={() => setPage(currentPage + 1)}>
            {t('toolSettings.next')}
          </Button>
        </div>
      </nav>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr_auto]">
        <Button
          type="primary"
          disabled={
            busy ||
            !changed ||
            !baselineKnown ||
            !catalog ||
            catalog.truncated ||
            !!client.pending()
          }
          onClick={() => void act(false)}
        >
          {t('save')}
        </Button>
        <Input
          aria-label={t('version')}
          placeholder={t('version')}
          maxLength={128}
          value={version}
          disabled={busy}
          onChange={event => setVersion(event.target.value)}
        />
        <Button
          disabled={
            busy ||
            !version.trim() ||
            !baselineKnown ||
            !catalog ||
            catalog.truncated ||
            !!client.pending()
          }
          onClick={() => void act(true)}
        >
          {t('toolSettings.publish')}
        </Button>
      </div>
      <p className="text-sm text-text-secondary">{t('toolAccessHint')}</p>
    </section>
  )
}
