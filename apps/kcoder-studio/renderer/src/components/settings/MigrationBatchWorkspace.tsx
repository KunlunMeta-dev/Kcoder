import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { ProjectTargetCatalogCache } from '../../../../shared/migrationProjectMapping'
import { MigrationProjectMapping } from './MigrationProjectMapping'
import { MigrationDiscoveryProblems } from './MigrationDiscoveryProblems'
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm'
import { createInitialResourceDraft, initialResourceSelection } from '../../../../shared/migrationInitialResourceLimits'
import { MigrationAgentChoice } from './MigrationAgentChoice'
import { MigrationInstructionSavedPreview } from './MigrationInstructionSavedPreview'
import { MigrationPrivateCredentials } from './MigrationPrivateCredentials'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { MigrationResourceBudgetPanel } from './MigrationResourceBudgetPanel'
import { MigrationDefinitionPreview } from './MigrationDefinitionPreview'
import { MemoryScopePicker } from './MemoryScopePicker'
import { MigrationCodexLayerReport } from './MigrationCodexLayerReport'
import { MigrationConfigurationLayers } from './MigrationConfigurationLayers'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MigrationCredentialPanel } from './MigrationCredentialPanel'
import { MigrationBatchHistoryPicker } from './MigrationBatchHistoryPicker'
import { MigrationPluginsPanel } from './MigrationPluginsPanel'
import { MigrationMcpCredentialPanel } from './MigrationMcpCredentialPanel'
import { MigrationMcpCredentialSummary } from './MigrationMcpCredentialSummary'
import { MigrationMcpPrivateFieldPicker } from './MigrationMcpPrivateFieldPicker'
import { mcpCandidatePrivateFields } from '@/kcoder/migrationMcpFields'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationBatch } from '@/kcoder/useMigrationBatch'
import { MigrationProjectMcpPicker } from './MigrationProjectMcpPicker'
import type {
  MigrationAgentAdaptation,
  MigrationBatchChoice,
  MigrationItemPreview,
  MigrationJobRecord,
} from '../../../../shared/generated/contracts'

type Props = {
  deviceId: string
  destination?: GatewayServer
  targets?: GatewayServer[]
  workspacePath?: string
  isCurrent: () => boolean
  onBusy: (busy: boolean) => void
  initialJobId?: string
  recordsOnly?: boolean
  onOpenRecord: (record: MigrationJobRecord) => void
  onLegacy: (id: string) => void
}

export function MigrationBatchWorkspace(props: Props) {
  const { t, i18n } = useTranslation('migration')
  const projectCatalog = useMemo(() => new ProjectTargetCatalogCache(JSON.stringify([props.deviceId, props.workspacePath ?? null])), [props.deviceId, props.workspacePath])
  const model = useMigrationBatch(
    props.deviceId,
    props.workspacePath,
    props.isCurrent,
    props.onLegacy
  )
  const [initialResources, setInitialResources] = useState(createInitialResourceDraft)
  const initialSelection = initialResourceSelection(initialResources)
  const initialized = useRef(false)
  const [credentialFor, setCredentialFor] = useState<string | null>(null)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [mcpCredentialFor, setMcpCredentialFor] = useState<string | null>(null)
  const [focusItem, setFocusItem] = useState<string | null>(null)
  const itemElements = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    if (!focusItem) return
    const element = itemElements.current.get(focusItem)
    if (!element) return
    element.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    element.focus({ preventScroll: true })
    setFocusItem(null)
  }, [focusItem, model.page.items])
  const { onBusy, recordsOnly, initialJobId } = props
  const { busy, listRecords, openRecord } = model
  const [pluginBusy, setPluginBusy] = useState(false)
  const [pluginPickerOpen, setPluginPickerOpen] = useState(false)
  const [privateBusy, setPrivateBusy] = useState(false)
  const working = busy || credentialBusy || pluginBusy || privateBusy
  const [sourcePage, setSourcePage] = useState(0),
    [editing, setEditing] = useState<string | null>(null)
  useEffect(() => {
    onBusy(working || model.workerRunning)
    return () => onBusy(false)
  }, [working, model.workerRunning, onBusy])
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (recordsOnly) void listRecords()
    else if (initialJobId) void openRecord(initialJobId)
  }, [recordsOnly, initialJobId, listRecords, openRecord])
  const status = model.job?.job.status
  const privateReadBlocked = model.mcpPrivate.loading || Boolean(model.mcpPrivate.error)
  const issueText = (item: MigrationItemPreview) =>
    item.issues.map(issue => t(`issues.${issue.code}`, { defaultValue: t('issue') })).join(' · ')
  const error = model.error && (
    <p role="alert" className="rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {t(`errors.${model.error}`, { defaultValue: t('error') })}
    </p>
  )
  if (props.recordsOnly)
    return (
      <section className="mt-4 space-y-3" aria-busy={working}>
        {error}
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium">{t('batch.records')}</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            onClick={() => void model.listRecords()}
          >
            {t('refresh')}
          </Button>
        </div>
        {model.records?.jobs.length === 0 && (
          <p className="py-6 text-center text-sm text-text-secondary">{t('batch.no_records')}</p>
        )}
        <div className="divide-y divide-border">
          {model.records?.jobs.map(record => (
            <button
              key={record.job.jobId}
              data-testid={`migration-batch-record-${record.job.jobId}`}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
              disabled={working}
              onClick={() => props.onOpenRecord(record)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {record.source === 'codex' ? 'Codex' : 'Claude Code'} ·{' '}
                  {record.createdAtMs
                    ? new Date(record.createdAtMs).toLocaleString(i18n.language)
                    : t('batch.unknown_time')}
                </span>
                <span className="mt-1 block text-xs text-text-secondary">
                  {t('batch.record_count', {
                    count: record.job.committedItems + (record.reusedItems ?? 0),
                    total: record.selectedItems || record.job.totalItems,
                  })}
                </span>
              </span>
              <span className="shrink-0 text-xs text-text-secondary">
                {t(`batch.statuses.${record.job.status}`)}
              </span>
            </button>
          ))}
        </div>
        <Pagination
          page={model.recordPage}
          previousDisabled={working || model.recordPage === 0}
          nextDisabled={working || !model.records?.nextCursor}
          onPrevious={() => void model.listRecords(-1)}
          onNext={() => void model.listRecords(1)}
        />
      </section>
    )
  return (
    <section className="mt-4 space-y-4" aria-busy={working}>
      {error}
      <p className="text-xs leading-5 text-text-secondary">{t('remote')}</p>
      {model.phase === 'source' && (
        <>
          <h3 className="text-base font-medium">{t('sources')}</h3>
          <div className="flex gap-2">
            {(['claude-code', 'codex'] as const).map(kind => (
              <Button
                key={kind}
                variant={model.kind === kind ? 'secondary' : 'outline'}
                aria-pressed={model.kind === kind}
                disabled={working}
                onClick={() => {
                  model.setKind(kind)
                  setSourcePage(0)
                }}
              >
                {kind === 'codex' ? 'Codex' : 'Claude Code'}
              </Button>
            ))}
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={model.includeProject}
              disabled={working}
              onChange={event => {
                model.setIncludeProject(event.target.checked)
                setSourcePage(0)
              }}
            />
            {t('project')}
          </label>
          <Button
            disabled={working}
            onClick={() => {
              setSourcePage(0)
              void model.discover()
            }}
          >
            {t('find')}
          </Button>
          {model.discovery && (
            <>
              <div className="studio-card divide-y divide-border rounded-lg border border-border">
                {model.discovery.sources
                  .slice(sourcePage * 10, sourcePage * 10 + 10)
                  .map(source => (
                    <div
                      key={source.sourceId}
                      data-testid={`migration-source-row-${source.sourceId}`}
                    >
                      <label className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={model.sources.has(source.sourceId)}
                          disabled={working}
                          onChange={event =>
                            model.toggleSource(source.sourceId, event.target.checked)
                          }
                        />
                        <span>
                          {source.displayName} ·{' '}
                          {t(source.scope === 'project' ? 'project_scope' : source.scope, {
                            defaultValue: source.scope,
                          })}
                        </span>
                      </label>
                      {source.kind === 'codex' &&
                        source.scope === 'user' &&
                        model.includeProject && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={working}
                            data-testid={`migration-codex-merge-${source.sourceId}`}
                            onClick={() => {
                              setSourcePage(0)
                              void model.deriveCodexLayers(source.sourceId)
                            }}
                          >
                            {t('codex_layers.merge')}
                          </Button>
                        )}
                      {source.scope === 'codex-project-layers' && (
                        <>
                          <p className="px-3 text-xs text-text-secondary">
                            {t('codex_layers.replacement')}
                          </p>
                          <MigrationCodexLayerReport
                            deviceId={props.deviceId}
                            workspacePath={props.workspacePath}
                            isCurrent={props.isCurrent}
                            target={{ kind: 'source', sourceId: source.sourceId }}
                          />
                        </>
                      )}
                      {source.scope === 'project-effective' && (
                        <MigrationConfigurationLayers
                          deviceId={props.deviceId}
                          workspacePath={props.workspacePath}
                          isCurrent={props.isCurrent}
                          target={{ kind: 'source', sourceId: source.sourceId }}
                        />
                      )}
                    </div>
                  ))}
              </div>
              {model.discovery.sources.length === 0 && !model.discovery.problems?.length && (
                <p className="text-sm text-text-secondary">{t('empty')}</p>
              )}
              <MigrationDiscoveryProblems problems={model.discovery.problems ?? []} />
              {model.discovery.sources.length > 10 && (
                <Pagination
                  page={sourcePage}
                  previousDisabled={working || sourcePage === 0}
                  nextDisabled={working || (sourcePage + 1) * 10 >= model.discovery.sources.length}
                  onPrevious={() => setSourcePage(old => old - 1)}
                  onNext={() => setSourcePage(old => old + 1)}
                />
              )}
            </>
          )}
          <MigrationBatchHistoryPicker model={model.historySources} disabled={working} />
          <Button
            variant="outline"
            disabled={working}
            data-testid="migration-batch-plugin-picker-toggle"
            onClick={() => setPluginPickerOpen(old => !old)}
          >
            {t('batch.plugin_picker')}
          </Button>
          {pluginPickerOpen && (
            <MigrationPluginsPanel
              key={model.kind}
              deviceId={props.deviceId}
              workspacePath={props.workspacePath}
              isCurrent={props.isCurrent}
              sourceKind={model.kind}
              onBusy={setPluginBusy}
              onSelectForBatch={model.selectPlugin}
            />
          )}
          {model.plugins.length > 0 && (
            <div className="space-y-2 text-sm" data-testid="migration-batch-selected-plugins">
              <p>{t('batch.plugin_selected', { count: model.plugins.length })}</p>
              {model.plugins.map(plugin => (
                <div key={plugin.operationId} className="flex items-center justify-between gap-2">
                  <span>{plugin.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working}
                    onClick={() => model.removePlugin(plugin.operationId)}
                  >
                    {t('batch.plugin_remove')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <MigrationInitialResourceForm draft={initialResources} onChange={setInitialResources} disabled={working}/>
          <Button
            data-testid="migration-initial-scan"
            disabled={
              working || !initialSelection.valid ||
              model.sources.size + model.historySources.selections.length + model.plugins.length ===
                0
            }
            onClick={() => void model.scan(initialSelection.limits)}
          >
            {t('batch.scan')}
          </Button>
        </>
      )}
      {model.job && (
        <>
          {props.destination && model.job.batch?.planId && <MigrationPrivateCredentials target={props.destination} targets={props.targets ?? []} job={model.job} isCurrent={props.isCurrent} onPrepared={model.acceptUpdatedJob} onBusy={setPrivateBusy}/>}
          <MigrationResourceBudgetPanel deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={model.job.job.jobId} planId={model.job.batch?.planId} status={model.job.job.status} unresolvedActions={model.job.batch?.unresolvedActions} isCurrent={props.isCurrent}/>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-medium">{t(`batch.phases.${model.phase}`)}</h3>
            <span className="text-xs text-text-secondary">
              {model.phase === 'configure'
                ? t('batch.selected', {
                    count: model.selected.size,
                    total: model.job.job.totalItems,
                  })
                : t('batch.record_count', {
                    count: model.job.job.committedItems + (model.job.batch?.reusedItems ?? 0),
                    total: model.job.batch?.selectedItems ?? 0,
                  })}
            </span>
          </div>
          {(model.phase === 'progress' || model.phase === 'result') && (
            <p role="status" className="text-sm text-text-secondary">
              {t(`batch.statuses.${status}`)}
            </p>
          )}
          {model.settling && !model.workerRunning && (
            <p role="status" className="text-sm text-text-secondary">
              {t('batch.settling')}
            </p>
          )}
          {model.workerProgress && (
            <p role="status" className="text-sm text-text-secondary">
              {t('batch.worker_progress', {
                index: model.workerProgress.actionIndex + 1,
                total: model.workerProgress.totalActions,
              })}
              {model.workerProgress.history &&
                ` · ${t(`history.phases.${model.workerProgress.history.phase}`)} · ${t(`history.progress_${model.workerProgress.history.unit}`, { processed: model.workerProgress.history.processed.toLocaleString(), total: model.workerProgress.history.total.toLocaleString() })}`}
            </p>
          )}
          {model.workerError && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${model.workerError}`, { defaultValue: t('batch.worker_stopped') })}
            </p>
          )}
          {model.job.batch?.atomicCredentials && privateReadBlocked && (
            <div role="status" className="space-y-2 text-sm text-text-secondary">
              <p>{t(model.mcpPrivate.loading ? 'batch_mcp.loading' : 'batch_mcp.read_failed')}</p>
              {model.mcpPrivate.error && (
                <Button size="sm" variant="outline" onClick={model.mcpPrivate.refresh}>
                  {t('refresh')}
                </Button>
              )}
            </div>
          )}
          {model.phase === 'configure' && (
            <p className="text-sm leading-6 text-text-secondary">{t('batch.configure_notice')}</p>
          )}
          {model.phase === 'configure' && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={working}
                checked={model.reuseExisting}
                onChange={event => model.setReuseExisting(event.target.checked)}
              />
              {t('batch.reuse_option')}
            </label>
          )}
          {Boolean(model.job?.batch?.reusedItems) && (
            <p role="status" className="text-sm text-text-secondary">
              {t('batch.reuse_count', { count: model.job?.batch?.reusedItems })}
            </p>
          )}
          <div className="studio-card divide-y divide-border rounded-lg border border-border">
            {model.page.items.map(item => {
              const draft = model.page.drafts?.find(draft => draft.itemId === item.id),
                planned = model.page.planned?.find(value => value.itemId === item.id)
              const credential = model.job?.credentialPlans?.find(value => value.itemId === item.id)
              const template = model.page.templates?.find(value => value.itemId === item.id)
              const mcpCandidate = model.page.mcps?.find(value => value.itemId === item.id)
              const privatePlan = model.mcpPrivate.plans.find(value => value.itemId === item.id)
              const dependencySelected = Boolean(
                template?.providerItemId && model.selected.has(template.providerItemId)
              )
              const canEdit = Boolean(
                item.category === 'project' || (item.category === 'plugin' &&
                  !item.issues.some(
                    issue => issue.severity === 'blocking' && (issue.phase ?? 'import') === 'import'
                  )) ||
                model.page.providers?.some(value => value.itemId === item.id) ||
                model.page.mcps?.some(value => value.itemId === item.id) ||
                (template?.providerItemId &&
                  !item.issues.some(
                    issue => issue.severity === 'blocking' && (issue.phase ?? 'import') === 'import'
                  )) ||
                (model.page.assets?.some(value => value.itemId === item.id) &&
                  !item.issues.some(
                    issue => issue.severity === 'blocking' && (issue.phase ?? 'import') === 'import'
                  ))
              )
              return (
                <div
                  key={item.id}
                  data-testid="migration-content-item"
                  tabIndex={-1}
                  ref={element => {
                    if (element) itemElements.current.set(item.id, element)
                    else itemElements.current.delete(item.id)
                  }}
                  className="px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex min-w-0 items-center gap-3">
                      {model.phase === 'configure' && (
                        <input
                          type="checkbox"
                          aria-label={t('batch.select_item', { name: item.sourceName })}
                          checked={model.selected.has(item.id)}
                          disabled={working || !model.choice(item.id)}
                          onChange={event => model.choose(item.id, event.target.checked)}
                        />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm" title={item.sourceName}>
                          {item.sourceName}
                        </span>
                        <span className="mt-1 block truncate text-xs text-text-secondary">
                          {planned?.targetName ??
                            (model.phase === 'configure' ? draft?.targetName : undefined)}
                        </span>
                      </span>
                    </label>
                    <div className="flex shrink-0 gap-1">
                      {model.phase === 'configure' && canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => setEditing(old => (old === item.id ? null : item.id))}
                        >
                          {t('batch.options')}
                        </Button>
                      )}
                      {(model.page.assets?.some(value => value.itemId === item.id) || planned) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={working}
                          onClick={() => void model.inspect(item.id)}
                        >
                          {t('batch.inspect')}
                        </Button>
                      )}
                    </div>
                  </div>
                  {['agent', 'hook'].includes(item.category) && <p className="mt-2 text-xs leading-5 text-text-secondary">{t('definitionsPending')}</p>}
                  {['agent', 'hook'].includes(item.category) && model.job && <MigrationDefinitionPreview deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={model.job.job.jobId} itemId={item.id} isCurrent={props.isCurrent}/>}
                  {item.category === 'project' && model.job && model.phase !== 'configure' && <MigrationProjectMapping readOnly deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={model.job.job.jobId} itemId={item.id} isCurrent={props.isCurrent}/>}
                  {item.category === 'instructions' && model.job && <MigrationInstructionSavedPreview deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={model.job.job.jobId} itemId={item.id} isCurrent={props.isCurrent}/>}

                  {model.phase === 'configure' && item.issues.length > 0 && (
                    <p className="mt-2 text-xs leading-5 text-text-secondary">{issueText(item)}</p>
                  )}
                  {model.phase === 'configure' && template && (
                    <div className="mt-2 space-y-1 text-xs leading-5 text-text-secondary">
                      <p>
                        {t('template.dependency', {
                          name: template.providerName ?? t('template.missing_provider'),
                        })}
                      </p>
                      <p>
                        {t(
                          dependencySelected
                            ? 'template.provider_selected'
                            : 'template.provider_required'
                        )}
                      </p>
                      {template.providerPageIndex != null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => {
                            setEditing(null)
                            setFocusItem(template.providerItemId ?? null)
                            void model.goToPage(template.providerPageIndex!)
                          }}
                        >
                          {t('template.open_provider')}
                        </Button>
                      )}
                    </div>
                  )}
                  {['provider', 'mcp'].includes(item.category) &&
                    model.job &&
                    (model.job.source === 'codex' ? (
                      <MigrationCodexLayerReport
                        deviceId={props.deviceId}
                        workspacePath={props.workspacePath}
                        isCurrent={props.isCurrent}
                        target={{ kind: 'job', jobId: model.job.job.jobId, itemId: item.id }}
                      />
                    ) : (
                      <MigrationConfigurationLayers
                        deviceId={props.deviceId}
                        workspacePath={props.workspacePath}
                        isCurrent={props.isCurrent}
                        target={{ kind: 'job', jobId: model.job.job.jobId, itemId: item.id }}
                      />
                    ))}
                  {planned?.errorCode && (
                    <p className="mt-2 text-sm text-destructive">
                      {t(`errors.${planned.errorCode}`, { defaultValue: t('error') })}
                    </p>
                  )}
                  {model.phase === 'configure' &&
                    model.choice(item.id)?.kind === 'provider' &&
                    model.selected.has(item.id) && (
                      <div className="mt-3 space-y-2 rounded-md bg-surface p-3">
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            disabled={working}
                            checked={Boolean(model.credentials[item.id])}
                            onChange={event =>
                              model.chooseCredential(
                                item.id,
                                event.target.checked
                                  ? model.kind === 'codex'
                                    ? 'environment'
                                    : 'configuration'
                                  : undefined
                              )
                            }
                          />
                          {t('batch.credential_consent')}
                        </label>
                        <p className="text-xs leading-5 text-text-secondary">
                          {t('credential.boundary')}
                        </p>
                        {model.credentials[item.id] && (
                          <label className="block text-sm">
                            <span className="mb-1 block text-text-secondary">
                              {t('credential.source')}
                            </span>
                            <SettingsSelect
                              className="h-9 w-full rounded-md border border-border bg-background px-2"
                              value={model.credentials[item.id]}
                              disabled={working}
                              onChange={event =>
                                model.chooseCredential(
                                  item.id,
                                  event.target.value === 'configuration'
                                    ? 'configuration'
                                    : 'environment'
                                )
                              }
                            >
                              {model.kind !== 'codex' && (
                                <option value="configuration">
                                  {t('credential.configuration')}
                                </option>
                              )}
                              <option value="environment">{t('credential.environment')}</option>
                            </SettingsSelect>
                          </label>
                        )}
                      </div>
                    )}
                  {credential && (
                    <div className="mt-3 space-y-1 rounded-md bg-surface p-3 text-xs leading-5">
                      <p className="font-medium">
                        {t('credential.title')} · {t(`credential.phases.${credential.phase}`)}
                      </p>
                      <p className="break-all">
                        {credential.targetName} · {credential.endpoint}
                      </p>
                      <p>
                        {t(`credential.${credential.storage}`)} · {credential.sourceField}
                      </p>
                      <p className="text-text-secondary">
                        {t(
                          credential.storage === 'file'
                            ? 'credential.file_notice'
                            : 'credential.keyring_notice'
                        )}
                      </p>
                      {credential.errorCode && (
                        <p role="alert" className="text-destructive">
                          {t(`errors.${credential.errorCode}`, { defaultValue: t('error') })}
                        </p>
                      )}
                    </div>
                  )}
                  {model.phase === 'configure' &&
                    mcpCandidate &&
                    model.selected.has(item.id) &&
                    mcpCandidatePrivateFields(mcpCandidate).length > 0 && (
                      <details
                        data-testid="migration-batch-mcp-fields"
                        className="mt-3 space-y-3 rounded-md bg-surface p-3"
                      >
                        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60">
                          {t('batch_mcp.choose')} ·{' '}
                          {t('mcp_credential.selected', {
                            count: model.mcpCredentials[item.id]?.fields.length ?? 0,
                            total: mcpCandidatePrivateFields(mcpCandidate).length,
                          })}
                        </summary>
                        <p className="text-xs leading-5 text-text-secondary">
                          {t('batch_mcp.boundary')}
                        </p>
                        {model.mcpPrivate.supported && !privateReadBlocked ? (
                          <MigrationMcpPrivateFieldPicker
                            fields={mcpCandidatePrivateFields(mcpCandidate)}
                            selected={model.mcpCredentials[item.id]?.fields ?? []}
                            consent={model.mcpCredentials[item.id]?.consentPrivateValues ?? false}
                            disabled={working}
                            onFields={fields => model.chooseMcpFields(item.id, fields)}
                            onConsent={consent => model.consentMcpFields(item.id, consent)}
                          />
                        ) : (
                          <>
                            <p role="status" className="text-sm text-text-secondary">
                              {t(
                                model.mcpPrivate.loading
                                  ? 'batch_mcp.loading'
                                  : model.mcpPrivate.error
                                    ? 'batch_mcp.read_failed'
                                    : 'batch_mcp.unsupported'
                              )}
                            </p>
                            {model.mcpPrivate.error && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={working}
                                onClick={model.mcpPrivate.refresh}
                              >
                                {t('refresh')}
                              </Button>
                            )}
                          </>
                        )}
                      </details>
                    )}
                  {privatePlan && <MigrationMcpCredentialSummary plan={privatePlan} />}
                  {model.phase !== 'configure' && (
                    <p className="mt-2 text-xs text-text-secondary">
                      {planned?.reused
                        ? t(
                            item.status === 'skipped'
                              ? 'batch.reused'
                              : item.status === 'rolled_back'
                                ? 'batch.reuse_undone'
                                : item.status === 'staged' || item.status === 'committing'
                                  ? 'batch.will_reuse'
                                  : `batch.item_statuses.${item.status}`
                          )
                        : planned
                          ? t(`batch.item_statuses.${item.status}`)
                          : t('batch.not_selected')}
                    </p>
                  )}
                  {model.page.providers?.some(provider => provider.itemId === item.id) &&
                    ['committed', 'skipped'].includes(item.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={working}
                        onClick={() => {
                          setMcpCredentialFor(null)
                          setCredentialFor(old => (old === item.id ? null : item.id))
                        }}
                      >
                        {t('credential.open')}
                      </Button>
                    )}
                  {mcpCandidate &&
                    !privatePlan &&
                    (!model.job?.batch?.atomicCredentials || !privateReadBlocked) &&
                    item.status === 'committed' &&
                    ((mcpCandidate.requiredEnv?.length ?? 0) > 0 ||
                      (mcpCandidate.requiredHeaders?.length ?? 0) > 0) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={working}
                        onClick={() => {
                          setCredentialFor(null)
                          setMcpCredentialFor(old => (old === item.id ? null : item.id))
                        }}
                      >
                        {t('mcp_credential.open')}
                      </Button>
                    )}
                  {mcpCredentialFor === item.id && model.job && (
                    <MigrationMcpCredentialPanel
                      key={`${model.job.job.jobId}:${item.id}`}
                      deviceId={props.deviceId}
                      workspacePath={props.workspacePath}
                      isCurrent={props.isCurrent}
                      job={model.job}
                      itemId={item.id}
                      candidate={mcpCandidate}
                      onUpdated={model.acceptUpdatedJob}
                      onBusy={setCredentialBusy}
                      onClose={() => setMcpCredentialFor(null)}
                    />
                  )}
                  {credentialFor === item.id && model.job && (
                    <MigrationCredentialPanel
                      key={`${model.job.job.jobId}:${item.id}`}
                      deviceId={props.deviceId}
                      workspacePath={props.workspacePath}
                      isCurrent={props.isCurrent}
                      job={model.job}
                      itemId={item.id}
                      onUpdated={model.acceptUpdatedJob}
                      onBusy={setCredentialBusy}
                      onClose={() => setCredentialFor(null)}
                    />
                  )}
                  {editing === item.id && model.phase === 'configure' && (item.category === 'project' ? <MigrationProjectMapping catalog={projectCatalog} deviceId={props.deviceId} workspacePath={props.workspacePath} jobId={model.job!.job.jobId} itemId={item.id} isCurrent={props.isCurrent} onSave={choice => { model.configure(choice); setEditing(null) }} onCancel={() => setEditing(null)}/> :
                    <BatchChoiceEditor
                      deviceId={props.deviceId}
                      jobId={model.job!.job.jobId}
                      isCurrent={props.isCurrent}
                      workspacePath={props.workspacePath}
                      key={item.id}
                      item={item}
                      page={model.page}
                      initial={model.choice(item.id)}
                      name={draft?.targetName ?? ''}
                      dependencySelected={dependencySelected}
                      onSave={choice => {
                        model.configure(choice)
                        setEditing(null)
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </div>
              )
            })}
          </div>
          <Pagination
            page={model.pageIndex}
            previousDisabled={working || model.pageIndex === 0}
            nextDisabled={working || (model.pageIndex + 1) * 10 >= model.job.job.totalItems}
            onPrevious={() => void model.paginate(-1)}
            onNext={() => void model.paginate(1)}
          />
          {model.detail && (
            <div className="rounded-lg bg-surface p-3">
              <div className="mb-2 flex justify-between gap-2">
                <span className="text-sm font-medium">{t('batch.inspect')}</span>
                <Button size="sm" variant="ghost" onClick={model.closeDetail}>
                  {t('close')}
                </Button>
              </div>
              <pre
                tabIndex={0}
                className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-code"
              >
                {'text' in model.detail ? model.detail.text : JSON.stringify(model.detail, null, 2)}
              </pre>
              {'nextOffset' in model.detail && model.detail.nextOffset != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void model.moreDetail()}
                >
                  {t('asset_more')}
                </Button>
              )}
            </div>
          )}
          {model.phase === 'configure' && (
            <div className="space-y-2">
              <MigrationProjectMcpPicker {...model.projectMcp} disabled={working} />
              {model.mcpConsentPending && (
                <p role="status" className="text-sm text-text-secondary">
                  {t('batch_mcp.consent_pending')}
                </p>
              )}
              <div className="flex justify-between gap-2">
                <Button variant="ghost" disabled={working} onClick={model.reset}>
                  {t('back')}
                </Button>
                <Button
                  disabled={working || model.selected.size === 0 || model.mcpConsentPending}
                  onClick={() => void model.plan()}
                >
                  {t('batch.plan')}
                </Button>
              </div>
            </div>
          )}
          {model.phase === 'review' && (
            <>
              <p className="text-sm leading-6 text-text-secondary">{t('batch.review_notice')}</p>
              <div className="flex justify-between gap-2">
                <Button variant="ghost" disabled={working} onClick={() => void model.cancel()}>
                  {t('cancel')}
                </Button>
                <Button
                  disabled={
                    working || Boolean(model.job.batch?.atomicCredentials && privateReadBlocked)
                  }
                  onClick={() => void model.operate()}
                >
                  {t('batch.apply')}
                </Button>
              </div>
            </>
          )}
          {(model.phase === 'progress' || model.phase === 'result') && (
            <>
              <p className="text-xs leading-5 text-text-secondary">{t('batch.resume_notice')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={working}
                  onClick={() => {
                    model.mcpPrivate.refresh()
                    void model.refresh()
                  }}
                >
                  {t('refresh')}
                </Button>
                {!model.workerRunning &&
                  (model.phase === 'progress' ||
                    status === 'cancelled' ||
                    (Boolean(model.job.batch?.unresolvedActions) && status !== 'rolled_back')) && (
                    <Button
                      disabled={working}
                      onClick={() =>
                        void model.operate(
                          model.lastAction === 'rollback' ||
                            status === 'rolling_back' ||
                            status === 'rollback_conflict'
                        )
                      }
                    >
                      {t('batch.resume')}
                    </Button>
                  )}
                {Boolean(
                  model.job.job.committedItems ||
                  model.job.batch?.reusedItems ||
                  model.job.batch?.atomicCredentials
                ) &&
                  status !== 'rolling_back' && (
                    <Button
                      variant="outline"
                      disabled={
                        working ||
                        model.workerRunning ||
                        (model.job.job.hasUnconfirmedOutcomes &&
                          !model.job.batch?.atomicCredentials)
                      }
                      onClick={() => void model.operate(true)}
                    >
                      {t('rollback')}
                    </Button>
                  )}
                {model.phase === 'progress' &&
                  status !== 'rolling_back' &&
                  model.lastAction !== 'rollback' && (
                    <Button
                      variant="ghost"
                      disabled={model.cancelling || status === 'cancel_requested'}
                      onClick={() => void model.cancel()}
                    >
                      {t(model.cancelling ? 'batch.cancel_requesting' : status === 'cancel_requested' ? 'batch.statuses.cancel_requested' : 'cancel')}
                    </Button>
                  )}
                <Button
                  variant="ghost"
                  disabled={working || model.workerRunning}
                  onClick={model.reset}
                >
                  {t('back')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {working && (
        <p role="status" className="text-sm text-text-secondary">
          {t('busy')}
        </p>
      )}
    </section>
  )
}

function Pagination({
  page,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext,
}: {
  page: number
  previousDisabled: boolean
  nextDisabled: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  const { t } = useTranslation('migration')
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
      <span>{t('page', { page: page + 1 })}</span>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={previousDisabled} onClick={onPrevious}>
          {t('previous')}
        </Button>
        <Button variant="ghost" size="sm" disabled={nextDisabled} onClick={onNext}>
          {t('next')}
        </Button>
      </div>
    </div>
  )
}

function BatchChoiceEditor({
  deviceId, jobId, isCurrent,
  workspacePath,
  item,
  page,
  initial,
  name,
  dependencySelected,
  onSave,
  onCancel,
}: {
  deviceId: string
  jobId: string
  isCurrent(): boolean
  workspacePath?: string
  item: MigrationItemPreview
  page: ReturnType<typeof useMigrationBatch>['page']
  initial: MigrationBatchChoice | null
  name: string
  dependencySelected: boolean
  onSave: (choice: MigrationBatchChoice) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('migration')
  const provider = page.providers?.find(value => value.itemId === item.id),
    mcp = page.mcps?.find(value => value.itemId === item.id)
  const template = page.templates?.find(value => value.itemId === item.id)
  const memory = item.category === 'memory'
  const definition = item.category === 'agent' || item.category === 'hook'
  const [agentSelection, setAgentSelection] = useState<{ value: MigrationAgentAdaptation | null; ready: boolean }>({ value: null, ready: !initial || initial.kind !== 'asset' || !initial.agentAdaptation })
  const agentChanged = useCallback((value: MigrationAgentAdaptation | null, ready: boolean) => setAgentSelection(old => old.ready === ready && JSON.stringify(old.value) === JSON.stringify(value) ? old : { value, ready }), [])
  const [values, setValues] = useState({
    name: initial && 'targetName' in initial ? initial.targetName : name,
    endpoint: initial?.kind === 'provider' ? (initial.endpoint ?? '') : (provider?.endpoint ?? ''),
    model: initial?.kind === 'provider' ? (initial.model ?? '') : (provider?.model ?? ''),
    context:
      (initial?.kind === 'provider'
        ? initial.contextWindowTokens
        : provider?.contextWindowTokens
      )?.toString() ?? '',
    headroom:
      (initial?.kind === 'provider'
        ? initial.outputHeadroomTokens
        : provider?.outputHeadroomTokens
      )?.toString() ?? '',
    output:
      (initial?.kind === 'provider'
        ? initial.maxOutputTokens
        : provider?.maxOutputTokens
      )?.toString() ?? '',
    cwd: initial?.kind === 'mcp' ? (initial.cwd ?? '') : (mcp?.cwd ?? mcp?.sourceCwd ?? ''),
    enabled:
      initial?.kind === 'asset' || initial?.kind === 'mcp'
        ? (initial.enableAfterImport ?? false)
        : false,
    memoryMapping: initial?.kind === 'asset' ? initial.memoryMapping ?? '' : '',
  })
  const positive = (value: string) =>
    /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  const valid = Boolean(
    item.category !== 'project' && values.name.trim() && agentSelection.ready &&
    (!memory || values.memoryMapping === 'global' || values.memoryMapping === 'current_workspace' && !!workspacePath) &&
    (!template ||
      (values.name.trim().length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.name.trim()))) &&
    (!template || (template.providerItemId && dependencySelected)) &&
    (!provider ||
      (values.endpoint.trim() &&
        values.model.trim() &&
        positive(values.context) &&
        positive(values.headroom) &&
        positive(values.output)))
  )
  const save = () => {
    if (!valid) return
    const common = { itemId: item.id, targetName: values.name.trim() }
    onSave(
      provider
        ? {
            kind: 'provider',
            ...common,
            endpoint: values.endpoint.trim(),
            model: values.model.trim(),
            contextWindowTokens: Number(values.context),
            outputHeadroomTokens: Number(values.headroom),
            maxOutputTokens: Number(values.output),
          }
        : mcp
          ? {
              kind: 'mcp',
              ...common,
              cwd: values.cwd.trim() || undefined,
              enableAfterImport: values.enabled,
            }
          : template?.providerItemId
            ? { kind: 'template', ...common, providerItemId: template.providerItemId }
            : item.category === 'plugin'
              ? { kind: 'plugin', ...common }
              : { kind: 'asset', ...common, enableAfterImport: memory || definition ? false : values.enabled,
                ...(memory ? { memoryMapping: values.memoryMapping as 'global' | 'current_workspace' } : {}),
                ...(item.category === 'agent' && agentSelection.value ? { agentAdaptation: agentSelection.value } : {}) }
    )
  }
  const fields: Array<[keyof typeof values, string]> = provider
    ? [
        ['name', 'name'],
        ['endpoint', 'endpoint'],
        ['model', 'model'],
        ['context', 'context'],
        ['headroom', 'headroom'],
        ['output', 'output'],
      ]
    : mcp
      ? [
          ['name', 'name'],
          ['cwd', 'mcp_cwd'],
        ]
      : [
          [
            'name',
            item.category === 'plugin'
              ? 'batch.plugin_name'
              : template
                ? 'template.name'
                : 'asset_name',
          ],
        ]
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-surface p-3">
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map(([key, label]) => (
          <label key={key} className="min-w-0 text-sm">
            <span className="mb-1 block text-text-secondary">{t(label)}</span>
            <input
              aria-label={t(label)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm max-md:min-h-11"
              value={String(values[key])}
              onChange={event => setValues(old => ({ ...old, [key]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      {definition && <p className="text-xs leading-5 text-text-secondary">{t('definitionsPending')}</p>}
      {item.category === 'agent' && <MigrationAgentChoice deviceId={deviceId} workspacePath={workspacePath} jobId={jobId} itemId={item.id} isCurrent={isCurrent} initial={initial?.kind === 'asset' ? initial.agentAdaptation : null} onChange={agentChanged}/>}
      {memory && <MemoryScopePicker value={values.memoryMapping} workspacePath={workspacePath} onChange={memoryMapping => setValues(old => ({ ...old, memoryMapping }))}/>}
      {!provider && !template && item.category !== 'plugin' && !memory && !definition && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={event => setValues(old => ({ ...old, enabled: event.target.checked }))}
          />
          {t('asset_enable')}
        </label>
      )}
      {provider && <p className="text-xs leading-5 text-text-secondary">{t('limits')}</p>}
      {template && (
        <div className="space-y-1 text-xs leading-5 text-text-secondary">
          <p>{t('template.name_help')}</p>
          <p>{t('template.boundary')}</p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('close')}
        </Button>
        <Button size="sm" disabled={!valid} onClick={save}>
          {t('batch.save_options')}
        </Button>
      </div>
    </div>
  )
}
