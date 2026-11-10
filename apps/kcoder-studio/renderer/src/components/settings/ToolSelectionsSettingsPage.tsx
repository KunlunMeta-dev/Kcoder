import { WebSearchDetails } from './WebSearchDetails'
import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Check,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  File,
  Globe,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { ToolSelectionsResult } from '../../../../shared/generated/contracts'
import { Button } from '@/components/ui/button'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { useTranslation } from '@/hooks/useTranslation'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import {
  changedToolSelection,
  projectToolSelections,
  readToolSelections,
  saveToolSelections,
  type ToolSelectionMode,
} from '@/kcoder/toolSelections'
import {
  IconSelect,
  InfoBox,
  InputWithIcon,
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsSwitch,
} from './settings-ui'

export function ToolSelectionsSettingsPage() {
  const { t } = useTranslation('common')
  const targets = useRuntimeSettingsTargets()
  const scope = usePluginTargetScope(targets.selectedServerId)
  return (
    <SettingsPage data-testid="tool-selections-settings-page">
      <SettingsPageHeader
        title={t('tool_selections.title')}
        description={t('tool_selections.new_sessions_only')}
        actions={
          <IconSelect
            icon={<Server className="h-4 w-4" />}
            data-testid="tool-selections-target"
            aria-label={t('tool_selections.target')}
            value={targets.selectedServerId}
            disabled={targets.loading}
            onChange={event => targets.selectTarget(event.target.value)}
          >
            <option value="" disabled>
              {t('tool_selections.target')}
            </option>
            {targets.targets.map(target => (
              <option key={target.id} value={target.id}>
                {target.label || target.id}
              </option>
            ))}
          </IconSelect>
        }
      />
      {targets.error && (
        <InfoBox variant="info" role="alert">
          {t('tool_selections.load_failed')}
        </InfoBox>
      )}
      {targets.selectedTarget && (
        <ToolSelectionEditor
          key={scope.key}
          target={targets.selectedTarget}
          isCurrent={scope.isCurrent}
        />
      )}
    </SettingsPage>
  )
}

function ToolSelectionEditor({
  target,
  isCurrent,
}: {
  target: GatewayServer
  isCurrent: () => boolean
}) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<ToolSelectionsResult | null>(null)
  const [mode, setMode] = useState<ToolSelectionMode>('kcoder')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verified, setVerified] = useState(false)
  const [notice, setNotice] = useState<'load_failed' | 'save_failed' | 'saved' | 'unknown' | null>(
    null
  )
  const generation = useRef(0)
  const savingRef = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    if (notice !== 'saved') return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice, snapshot?.revision])
  const publish = (result: ToolSelectionsResult) => {
    setSnapshot(result)
    setVerified(true)
    projectToolSelections(hookTargetScope(target), result)
  }
  async function load() {
    if (savingRef.current) return
    const request = ++generation.current
    setLoading(true)
    setNotice(null)
    setVerified(false)
    try {
      const result = await readToolSelections(target.id)
      if (!active.current || !isCurrent() || request !== generation.current) return
      publish(result)
    } catch {
      if (active.current && isCurrent() && request === generation.current) setNotice('load_failed')
    } finally {
      if (active.current && isCurrent() && request === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = true
    queueMicrotask(() => {
      if (active.current) void load()
    })
    return () => {
      active.current = false
      generation.current += 1
    }
    // The keyed editor owns one immutable target/account lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggle(name: string, enabled: boolean) {
    const selection = snapshot?.modes.find(item => item.mode === mode)
    const tool = snapshot?.tools.find(item => item.name === name)
    if (
      !snapshot ||
      !selection?.editable ||
      !tool?.available ||
      !tool.supportedModes.includes(mode) ||
      snapshot.truncated ||
      savingRef.current ||
      !verified ||
      !isCurrent()
    )
      return
    const request = ++generation.current
    const current = () => active.current && isCurrent() && request === generation.current
    savingRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const result = await saveToolSelections(
        target.id,
        mode,
        changedToolSelection(selection.allowedTools, name, enabled),
        snapshot.revision
      )
      if (!current()) return
      publish(result)
      setNotice('saved')
    } catch {
      if (!current()) return
      // A lost response may already have committed. Reconcile with a read only.
      setVerified(false)
      try {
        const result = await readToolSelections(target.id)
        if (!current()) return
        publish(result)
        setNotice('save_failed')
      } catch {
        if (current()) setNotice('unknown')
      }
    } finally {
      savingRef.current = false
      if (current()) setSaving(false)
    }
  }
  const selection = snapshot?.modes.find(item => item.mode === mode)
  const search = query.trim().toLocaleLowerCase()
  const tools =
    snapshot?.tools.filter(
      tool =>
        !search ||
        `${tool.name} ${tool.ui.displayName} ${tool.ui.description} ${tool.ui.group}`
          .toLocaleLowerCase()
          .includes(search)
    ) ?? []
  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(tools.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  if (page > pageCount) setPage(pageCount)
  const pageTools = tools.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  function selectMode(next: ToolSelectionMode) {
    setMode(next)
    setPage(1)
  }
  return (
    <div className="space-y-5" aria-busy={loading || saving}>
      <p className="text-sm text-text-secondary" data-testid="tool-selections-default-scope">
        {t('tool_selections.default_scope')}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label={t('tool_selections.mode')}
          className="flex gap-1 rounded-xl bg-surface p-1"
        >
          {(['kcoder', 'kworker'] as const).map((item, index, modes) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`tool-selection-tab-${item}`}
              aria-selected={mode === item}
              aria-controls="tool-selection-panel"
              tabIndex={mode === item ? 0 : -1}
              data-testid={`tool-selections-mode-${item}`}
              className={`min-h-11 rounded-lg px-4 text-base ${mode === item ? 'bg-background font-medium text-text-primary shadow-sm' : 'text-text-secondary'}`}
              onClick={() => selectMode(item)}
              onKeyDown={event => {
                const next =
                  event.key === 'Home'
                    ? modes[0]
                    : event.key === 'End'
                      ? modes[1]
                      : event.key === 'ArrowRight'
                        ? modes[(index + 1) % 2]
                        : event.key === 'ArrowLeft'
                          ? modes[(index + 1) % 2]
                          : null
                if (next) {
                  event.preventDefault()
                  selectMode(next)
                  document.getElementById(`tool-selection-tab-${next}`)?.focus()
                }
              }}
            >
              {item === 'kcoder' ? 'KCoder' : 'KWorker'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="tool-selections-save-status"
            className="grid shrink-0 text-sm text-text-secondary"
          >
            {/* Reserve both translated widths so status changes cannot wrap the toolbar. */}
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 whitespace-nowrap"
            >
              {t('tool_selections.saving')}
            </span>
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              {t('tool_selections.saved')}
            </span>
            <span
              aria-hidden={!saving && notice !== 'saved'}
              className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap transition-opacity motion-reduce:transition-none ${saving || notice === 'saved' ? 'opacity-100' : 'opacity-0'}`}
            >
              {saving ? (
                t('tool_selections.saving')
              ) : (
                <>
                  <Check aria-hidden="true" className="h-4 w-4" />
                  {t('tool_selections.saved')}
                </>
              )}
            </span>
          </div>
          <Button
            variant="outline"
            data-testid="tool-selections-refresh"
            disabled={loading || saving}
            onClick={() => void load()}
          >
            <RefreshCw className="h-4 w-4" />
            {t('tool_selections.refresh')}
          </Button>
        </div>
      </div>
      <InputWithIcon
        icon={<Search className="h-4 w-4" />}
        data-testid="tool-selections-search"
        aria-label={t('tool_selections.search')}
        placeholder={t('tool_selections.search')}
        value={query}
        onChange={event => {
          setQuery(event.target.value)
          setPage(1)
        }}
      />
      {notice && notice !== 'saved' && (
        <InfoBox variant="info" role="alert">
          {t(`tool_selections.${notice}`)}
        </InfoBox>
      )}
      {snapshot?.truncated && <InfoBox variant="info">{t('tool_selections.truncated')}</InfoBox>}
      {selection && !selection.editable && (
        <InfoBox variant="info">{t('tool_selections.read_only')}</InfoBox>
      )}
      <div role="tabpanel" id="tool-selection-panel" aria-labelledby={`tool-selection-tab-${mode}`}>
        {loading && (
          <p role="status" className="text-sm text-text-secondary">
            {t('tool_selections.loading')}
          </p>
        )}
        {!loading && snapshot && (
          <SettingsGroup>
            {pageTools.map(tool => {
              const selected = selection?.allowedTools.includes(tool.name) ?? false
              const reason = !tool.available
                ? t(
                    tool.unavailableReason &&
                      [
                        'model_tools_disabled',
                        'inactive_edit_surface',
                        'disabled_by_configuration',
                      ].includes(tool.unavailableReason)
                      ? `tool_selections.${tool.unavailableReason}`
                      : 'tool_selections.unavailable'
                  )
                : !tool.supportedModes.includes(mode)
                  ? t('tool_selections.unsupported_mode')
                  : !selection?.editable
                    ? t('tool_selections.read_only')
                    : snapshot.truncated
                      ? t('tool_selections.truncated')
                      : null
              const Icon =
                {
                  tool: Wrench,
                  file: File,
                  search: Search,
                  terminal: Terminal,
                  agent: Bot,
                  globe: Globe,
                  checklist: ClipboardList,
                }[tool.ui.icon] ?? Wrench
              return (
                <div key={tool.name} className="flex items-center gap-3 p-4">
                  <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-base font-medium text-text-primary">
                      {tool.ui.displayName || tool.name}
                    </p>
                    <p
                      className="line-clamp-2 break-words text-sm text-text-secondary"
                      title={tool.ui.description}
                    >
                      {tool.ui.description}
                    </p>
                    {tool.name === 'WebSearch' && (
                      <WebSearchDetails
                        key={`${target.id}:${mode}:${snapshot.revision}`}
                        serverId={target.id}
                        mode={mode}
                        isCurrent={isCurrent}
                      />
                    )}
                    <p className="text-sm text-text-muted" data-testid="tool-selection-default">
                      {t(selected ? 'tool_selections.default_on' : 'tool_selections.default_off')}
                    </p>
                    {reason && (
                      <p
                        id={`tool-selection-reason-${tool.name}`}
                        className="text-sm text-text-muted"
                      >
                        {reason}
                      </p>
                    )}
                  </div>
                  <SettingsSwitch
                    data-testid={`tool-selection-${tool.name}`}
                    aria-label={tool.ui.displayName || tool.name}
                    aria-describedby={reason ? `tool-selection-reason-${tool.name}` : undefined}
                    checked={selected}
                    disabled={Boolean(reason) || !verified || loading || saving}
                    onCheckedChange={enabled => void toggle(tool.name, enabled)}
                  />
                </div>
              )
            })}
            {!tools.length && (
              <p className="p-4 text-sm text-text-secondary">{t('tool_selections.empty')}</p>
            )}
          </SettingsGroup>
        )}
        {!loading && snapshot && (
          <nav
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
            aria-label={t('tool_selections.pagination')}
            data-testid="tool-selections-pagination"
          >
            <p className="text-sm text-text-secondary" role="status" aria-live="polite">
              {t('tool_selections.page_summary', {
                page: currentPage,
                pages: pageCount,
                total: tools.length,
                size: pageSize,
              })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={currentPage <= 1 || saving}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                {t('tool_selections.previous_page')}
              </Button>
              <Button
                variant="outline"
                disabled={currentPage >= pageCount || saving}
                onClick={() => setPage(currentPage + 1)}
              >
                {t('tool_selections.next_page')}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        )}
      </div>
    </div>
  )
}
