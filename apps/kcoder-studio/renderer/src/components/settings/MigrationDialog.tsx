import { MigrationProjectSources } from './MigrationProjectSources'
import { MigrationDiscoveryProblems } from './MigrationDiscoveryProblems'
import { MigrationDefinitionSources } from './MigrationDefinitionSources'
import { MigrationCodexLayerReport } from './MigrationCodexLayerReport'
import { MigrationSourceBrowser } from './MigrationSourceBrowser'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { MigrationConfigurationLayers } from './MigrationConfigurationLayers'
import { useEffect, useState, useRef } from 'react'
import { MigrationBatchWorkspace } from './MigrationBatchWorkspace'
import { MigrationQuickHistory } from './MigrationQuickHistory'
import { MigrationHistoryWorkspace } from './MigrationHistoryWorkspace'
import { MigrationPluginsPanel } from './MigrationPluginsPanel'
import { MigrationCredentialPanel } from './MigrationCredentialPanel'
import { MigrationMcpCredentialPanel } from './MigrationMcpCredentialPanel'
import { ArrowRight, CheckCircle2, Loader2, Server } from 'lucide-react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { IconSelect } from './settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { MigrationMemorySources } from './MigrationMemorySources'
import { MemoryScopePicker } from './MemoryScopePicker'
import { MigrationSourceUploadWorkspace } from './MigrationSourceUploadWorkspace'
import { useMigration, type MigrationForm } from '@/kcoder/useMigration'
import type { MigrationIssue } from '../../../../shared/generated/contracts'

export function MigrationDialog({ onClose, target: fixedTarget, workspacePath: fixedWorkspace, initialMode, initialJobId }: { onClose: () => void; target?: GatewayServer; workspacePath?: string; initialMode?: 'batch' | 'memory'; initialJobId?: string }) {
  const { t } = useTranslation('migration')
  const targets = useRuntimeSettingsTargets()
  const matched = fixedTarget && targets.targets.find(item => item.id === fixedTarget.id && hookTargetScope(item) === hookTargetScope(fixedTarget))
  const target = fixedTarget ? matched || null : targets.selectedTarget
  const workspace = fixedTarget ? fixedWorkspace ?? target?.workspacePath : target?.workspacePath
  const destination = target && workspace !== target.workspacePath ? { ...target, workspacePath: workspace } : target
  const scope = usePluginTargetScope(target?.id, workspace)
  const [busy, setBusy] = useState(false)
  return (
    <ModalDialog
      title={t('title')}
      testId="migration-dialog"
      wide
      className="max-md:[&_button]:min-h-11 max-md:[&_select]:min-h-11"
      pending={false}
      onClose={onClose}
      closeLabel={t('close')}
    >
      <p className="mt-2 text-sm leading-6 text-text-secondary">{t('quickHistory.dialogDescription')}</p>
      <label className="mt-5 block text-sm text-text-primary" htmlFor="migration-target">
        {t('target')}
      </label>
      <IconSelect
        id="migration-target"
        icon={<Server className="h-4 w-4" />}
        value={fixedTarget ? target?.id ?? '' : targets.selectedServerId}
        disabled={!!fixedTarget || busy || targets.loading}
        onChange={event => targets.selectTarget(event.target.value)}
      >
        {!target && <option value="">{t('target_placeholder')}</option>}
        {(fixedTarget ? target ? [target] : [] : targets.targets).map(item => (
          <option key={item.id} value={item.id}>
            {item.label || item.id}
          </option>
        ))}
      </IconSelect>
      {(targets.error || fixedTarget && !targets.loading && !target) && (
        <div role="alert" className="mt-3 text-sm text-destructive">
          {t(fixedTarget ? 'firstUse.targetUnavailable' : 'target_error')}{' '}
          <Button variant="ghost" onClick={() => void targets.refresh()}>
            {t('refresh')}
          </Button>
        </div>
      )}
      {target && (
        <MigrationEntry
          key={scope.key}
          deviceId={target.id}
          targets={targets.targets}
          destination={destination ?? target}
          workspacePath={workspace}
          isCurrent={scope.isCurrent}
          onBusy={setBusy}
          initialMode={initialMode}
          initialJobId={initialJobId}
        />
      )}
    </ModalDialog>
  )
}

function MigrationEntry(props: {
  deviceId: string
  targets: GatewayServer[]
  destination: GatewayServer
  workspacePath?: string
  isCurrent: () => boolean
  onBusy: (value: boolean) => void
  initialMode?: 'batch' | 'memory'
  initialJobId?: string
}) {
  const { t } = useTranslation('migration')
  const { t: pluginText } = useTranslation('migrationPlugins')
  const { t: memoryText } = useTranslation('migrationMemory')
  const { t: definitionsText } = useTranslation('migrationDefinitions')
  const { t: uploadText } = useTranslation('migrationUpload')
  const [mode, setMode] = useState<'quick' | 'batch' | 'single' | 'records' | 'history' | 'plugins' | 'source' | 'memory' | 'upload' | 'definitions' | 'projects'>(props.initialMode ?? (props.initialJobId ? 'batch' : 'quick'))
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(props.initialMode || props.initialJobId))
  const [record, setRecord] = useState<string | undefined>(props.initialJobId)
  const [busy, setBusy] = useState(false)
  useBusy(busy, props.onBusy)
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant={mode === 'quick' ? 'secondary' : 'ghost'} disabled={busy} data-testid="migration-mode-quick" onClick={() => { setRecord(undefined); setMode('quick') }}>{t('quickHistory.tab')}</Button>
        <Button size="sm" variant={mode === 'records' ? 'secondary' : 'ghost'} disabled={busy} onClick={() => { setRecord(undefined); setMode('records') }}>{t('batch.records')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} data-testid="migration-advanced-toggle" aria-expanded={advancedOpen} aria-controls="migration-advanced-options" onClick={() => setAdvancedOpen(value => !value)}>{t('quickHistory.advanced')}</Button>
      </div>
      {advancedOpen && <div id="migration-advanced-options" className="mt-2 flex flex-wrap gap-2">
        {(['batch', 'single', 'history', 'plugins', 'source', 'memory', 'upload', 'definitions', 'projects'] as const).map(value => (
          <Button
            size="sm"
            key={value}
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            data-testid={`migration-mode-${value}`}
            disabled={busy}
            onClick={() => {
              setRecord(undefined)
              setMode(value)
            }}
          >
            {value === 'projects' ? t('projectSourceMode') : value === 'definitions' ? definitionsText('title') : value === 'upload' ? uploadText('title') : value === 'memory' ? memoryText('import') : value === 'source' ? t('transferBrowser.title') : value === 'plugins'
              ? pluginText('title')
              : t(
                  value === 'batch'
                    ? 'batch.quick'
                    : value === 'single'
                      ? 'batch.single'
                    : 'history.title'
                )}
          </Button>
        ))}
      </div>}
      {mode === 'quick' ? <MigrationQuickHistory target={props.destination} workspacePath={props.workspacePath} isCurrent={props.isCurrent} onBusy={setBusy}/> : mode === 'projects' ? <MigrationProjectSources {...props} onBusy={setBusy} onOpenBatch={id => { if (props.isCurrent()) { setRecord(id); setMode('batch') } }}/> : mode === 'definitions' ? <MigrationDefinitionSources {...props} onBusy={setBusy} onOpenBatch={id => { if (props.isCurrent()) { setRecord(id); setMode('batch') } }}/> : mode === 'upload' ? <MigrationSourceUploadWorkspace target={props.destination} targets={props.targets} isCurrent={props.isCurrent} onBusy={setBusy} onOpenBatch={id => { if (props.isCurrent()) { setRecord(id); setMode('batch') } }}/> : mode === 'memory' ? <MigrationMemorySources {...props} onBusy={setBusy} onOpenBatch={id => { if (props.isCurrent()) { setRecord(id); setMode('batch') } }}/>: mode === 'source' ? <MigrationSourceBrowser isCurrent={props.isCurrent} destination={props.destination} targets={props.targets} onBusy={setBusy}
        onOpenBatch={id => { if (props.isCurrent()) { setRecord(id); setMode('batch') } }}/> : mode === 'plugins' ? (
        <MigrationPluginsPanel
          deviceId={props.deviceId}
          workspacePath={props.workspacePath}
          isCurrent={props.isCurrent}
        />
      ) : mode === 'history' ? (
        <MigrationHistoryWorkspace {...props} onBusy={setBusy} />
      ) : mode === 'single' ? (
        <MigrationContent
          key={`single:${record ?? ''}`}
          {...props}
          onBusy={setBusy}
          initialJobId={record}
        />
      ) : (
        <MigrationBatchWorkspace
          key={`${mode}:${record ?? ''}`}
          {...props}
          onBusy={setBusy}
          initialJobId={record}
          recordsOnly={mode === 'records'}
          onOpenRecord={value => {
            setRecord(value.job.jobId)
            setMode(value.isBatch ? 'batch' : 'single')
          }}
          onLegacy={id => {
            setRecord(id)
            setMode('single')
          }}
        />
      )}
    </>
  )
}

function MigrationContent({
  deviceId,
  workspacePath,
  isCurrent,
  onBusy,
  initialJobId,
}: {
  deviceId: string
  workspacePath?: string
  isCurrent: () => boolean
  onBusy: (value: boolean) => void
  initialJobId?: string
}) {
  const { t } = useTranslation('migration')
  const model = useMigration(deviceId, workspacePath, isCurrent)
  const [credentialOpen, setCredentialOpen] = useState(false)
  const [mcpCredentialFor, setMcpCredentialFor] = useState<string | null>(null)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const working = model.busy || credentialBusy
  const { openRecord } = model
  const opened = useRef(false)
  useEffect(() => {
    if (initialJobId && !opened.current) {
      opened.current = true
      void openRecord(initialJobId)
    }
  }, [initialJobId, openRecord])
  // The shell remains closable after this target/account lifetime is replaced.
  useBusy(working, onBusy)
  const issues = (values: MigrationIssue[]) => (
    <ul className="space-y-1 text-sm text-text-secondary">
      {values.map((issue, index) => (
        <li key={`${issue.code}:${index}`}>
          {t(`issues.${issue.code}`, { defaultValue: t('issue') })}
        </li>
      ))}
    </ul>
  )
  const status = model.job?.job.status
  const title =
    status === 'rolling_back' || model.uncertainAction === 'rollback'
      ? 'rollback_unknown'
      : status === 'rolled_back'
        ? 'rolled_back'
        : status === 'cancelled'
          ? 'cancelled'
          : status === 'rollback_conflict'
            ? 'rollback_conflict'
            : model.job?.mcpPlans?.length
              ? 'saved_mcp'
              : model.job?.assetPlans?.length
                ? 'saved_asset'
                : 'saved'
  const planned = model.job?.plans[0]?.provider
  const plannedMcp = model.job?.mcpPlans?.[0]
  const plannedAsset = model.job?.assetPlans?.[0]
  const fields: Array<[keyof MigrationForm, string, boolean]> = [
    ['name', 'name', false],
    ['endpoint', 'endpoint', false],
    ['model', 'model', false],
    ['context', 'context', true],
    ['headroom', 'headroom', true],
    ['output', 'output', true],
  ]
  return (
    <section className="mt-5 space-y-4" aria-busy={working}>
      <p className="text-xs leading-5 text-text-secondary">{t('remote')}</p>
      <p className="rounded-lg bg-surface px-3 py-2 text-sm text-text-secondary">{t('scope')}</p>
      {model.error && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {t(`errors.${model.error}`, { defaultValue: t('error') })}
        </div>
      )}
      {model.stage === 'source' && (
        <>
          <h3 className="text-base font-medium">{t('sources')}</h3>
          <div className="grid grid-cols-2 gap-3">
            {(['claude-code', 'codex'] as const).map(kind => (
              <Button
                key={kind}
                variant={model.kind === kind ? 'secondary' : 'outline'}
                aria-pressed={model.kind === kind}
                disabled={working}
                onClick={() => {
                  model.setKind(kind)
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
              onChange={event => model.setIncludeProject(event.target.checked)}
            />
            {t('project')}
          </label>
          <Button disabled={working} onClick={() => void model.discover()}>
            {t('find')}
          </Button>
          {model.discovery && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">
                {t(model.discovery.sources.length ? 'found' : 'empty')}
              </h3>
              {model.sources.map(source => (
                <div key={source.sourceId}>
                  <Button
                    className="w-full justify-between"
                    variant="outline"
                    disabled={working}
                    onClick={() => void model.scan(source.sourceId)}
                  >
                    <span>
                      {source.displayName} ·{' '}
                      {t(source.scope === 'project' ? 'project_scope' : source.scope, {
                        defaultValue: source.scope,
                      })}
                    </span>
                    <ArrowRight />
                  </Button>
                  {source.scope === 'project-effective' && (
                    <MigrationConfigurationLayers
                      deviceId={deviceId}
                      workspacePath={workspacePath}
                      isCurrent={isCurrent}
                      target={{ kind: 'source', sourceId: source.sourceId }}
                    />
                  )}
                </div>
              ))}
              {model.discovery.sources.length > 10 && (
                <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
                  <span>{t('page', { page: model.sourcePage + 1 })}</span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working || model.sourcePage === 0}
                      onClick={() => model.paginateSources(-1)}
                    >
                      {t('previous')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        working || (model.sourcePage + 1) * 10 >= model.discovery.sources.length
                      }
                      onClick={() => model.paginateSources(1)}
                    >
                      {t('next')}
                    </Button>
                  </div>
                </div>
              )}
              <MigrationDiscoveryProblems problems={model.discovery.problems ?? []} />
            </div>
          )}
        </>
      )}
      {model.job &&
        (model.job.source === 'codex' ? (
          <MigrationCodexLayerReport
            deviceId={deviceId}
            workspacePath={workspacePath}
            isCurrent={isCurrent}
            target={{ kind: 'job', jobId: model.job.job.jobId }}
          />
        ) : (
          <MigrationConfigurationLayers
            deviceId={deviceId}
            workspacePath={workspacePath}
            isCurrent={isCurrent}
            target={{ kind: 'job', jobId: model.job.job.jobId }}
          />
        ))}
      {model.stage === 'configure' && (
        <>
          <h3 className="text-base font-medium">{t('configure')}</h3>
          <p className="text-xs text-text-secondary">
            {t('detected', { count: model.job?.job.totalItems ?? 0 })}
          </p>
          <div className="studio-card divide-y divide-border rounded-lg border border-border">
            {model.page.items.map(item => {
              const provider = model.page.providers?.find(value => value.itemId === item.id)
              const mcp = model.page.mcps?.find(value => value.itemId === item.id)
              const asset = model.page.assets?.find(value => value.itemId === item.id)
              return (
                <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm" title={item.sourceName}>
                    {item.sourceName}
                  </span>
                  {provider ? (
                    <Button
                      variant={model.candidate?.itemId === item.id ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={model.candidate?.itemId === item.id}
                      disabled={working}
                      onClick={() => model.selectCandidate(provider, item)}
                    >
                      {t('choose')}
                    </Button>
                  ) : mcp ? (
                    <Button
                      variant={model.mcpCandidate?.itemId === item.id ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={model.mcpCandidate?.itemId === item.id}
                      disabled={working}
                      onClick={() => model.selectMcp(mcp, item)}
                    >
                      {t('choose')}
                    </Button>
                  ) : asset ? (
                    <Button
                      variant={model.assetCandidate?.itemId === item.id ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={model.assetCandidate?.itemId === item.id}
                      disabled={working}
                      onClick={() => void model.selectAsset(asset, item)}
                    >
                      {t('choose')}
                    </Button>
                  ) : (
                    <span className="text-xs text-text-secondary">{t('unsupported_item')}</span>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
            <span>{t('page', { page: model.pageIndex + 1 })}</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={working || model.pageIndex === 0}
                onClick={() => void model.paginate(-1)}
              >
                {t('previous')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={working || !model.page.nextCursor}
                onClick={() => void model.paginate(1)}
              >
                {t('next')}
              </Button>
            </div>
          </div>
          {model.candidate && (
            <div className="grid gap-3 md:grid-cols-3">
              {fields.map(([field, label, numeric]) => (
                <label
                  key={field}
                  className={`min-w-0 text-sm ${field === 'endpoint' ? 'md:col-span-2' : field === 'model' ? 'md:col-span-3' : ''}`}
                >
                  <span className="mb-1 block text-text-secondary">{t(label)}</span>
                  <input
                    aria-label={t(label)}
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus/60 max-md:min-h-11"
                    disabled={working}
                    inputMode={numeric ? 'numeric' : undefined}
                    value={model.form[field]}
                    onChange={event =>
                      model.setForm(old => ({ ...old, [field]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {model.candidate && (
            <p className="text-xs leading-5 text-text-secondary">{t('limits')}</p>
          )}
          {model.assetCandidate && (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-text-secondary">{t('asset_name')}</span>
                <input
                  aria-label={t('asset_name')}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 max-md:min-h-11"
                  disabled={working || model.assetCandidate.nativeReference}
                  value={model.form.name}
                  onChange={event => model.setForm(old => ({ ...old, name: event.target.value }))}
                />
              </label>
              <p className="text-xs text-text-secondary">
                {t('asset_size', {
                  files: model.assetCandidate.files,
                  bytes: model.assetCandidate.bytes.toLocaleString(),
                })}
              </p>
              <pre
                tabIndex={0}
                aria-label={t('asset_preview')}
                className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-code"
              >
                {model.assetPreview?.text ?? t('busy')}
              </pre>
              {model.assetPreview?.nextOffset != null && (
                <Button
                  variant="ghost"
                  disabled={working}
                  onClick={() => void model.moreAssetPreview()}
                >
                  {t('asset_more')}
                </Button>
              )}
              {model.selectedItem?.category === 'memory' ? <MemoryScopePicker value={model.memoryMapping} disabled={working} workspacePath={workspacePath} onChange={value => model.setMemoryMapping(value as '' | 'global' | 'current_workspace')}/> : model.assetCandidate.nativeReference ? (
                <p className="text-sm text-text-secondary">{t('asset_native')}</p>
              ) : (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={working}
                    checked={model.enableAsset}
                    onChange={event => model.setEnableAsset(event.target.checked)}
                  />
                  {t('asset_enable')}
                </label>
              )}
              <p className="text-xs leading-5 text-text-secondary">{t('asset_notice')}</p>
            </div>
          )}
          {model.mcpCandidate && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                {model.mcpCandidate.transport} ·{' '}
                {model.mcpCandidate.command || model.mcpCandidate.url}
              </p>
              <label className="block text-sm">
                <span className="mb-1 block text-text-secondary">{t('name')}</span>
                <input
                  aria-label={t('name')}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 max-md:min-h-11"
                  disabled={working}
                  value={model.form.name}
                  onChange={event => model.setForm(old => ({ ...old, name: event.target.value }))}
                />
              </label>
              {model.mcpCandidate.transport === 'stdio' && (
                <label className="block text-sm">
                  <span className="mb-1 block text-text-secondary">{t('mcp_cwd')}</span>
                  <input
                    aria-label={t('mcp_cwd')}
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 max-md:min-h-11"
                    disabled={working}
                    value={model.mcpCwd}
                    onChange={event => model.setMcpCwd(event.target.value)}
                  />
                </label>
              )}
              <p className="text-xs text-text-secondary">{t('mcp_private')}</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={working}
                  checked={model.enableMcp}
                  onChange={event => model.setEnableMcp(event.target.checked)}
                />
                {t('mcp_enable')}
              </label>
            </div>
          )}
          {issues([...(model.job?.issues ?? []), ...(model.selectedItem?.issues ?? [])])}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" disabled={working} onClick={model.reset}>
              {t('back')}
            </Button>
            <Button disabled={working || !model.canPlan} onClick={() => void model.plan()}>
              {t('preview')}
            </Button>
          </div>
        </>
      )}
      {model.stage === 'review' && (
        <>
          <h3 className="text-base font-medium">{t('review')}</h3>
          <p className="text-sm leading-6">
            {t(plannedAsset ? 'asset_review' : plannedMcp ? 'mcp_review' : 'review_description', {
              name:
                plannedAsset?.targetName ??
                plannedMcp?.config.name ??
                model.job?.plans[0]?.targetName ??
                '',
            })}
          </p>
          {planned && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg bg-surface p-3 text-sm">
              <dt className="text-text-secondary">{t('model')}</dt>
              <dd className="min-w-0 break-words">{planned.model}</dd>
              <dt className="text-text-secondary">{t('endpoint')}</dt>
              <dd className="min-w-0 break-all">{planned.endpoint}</dd>
              <dt className="text-text-secondary">{t('context')}</dt>
              <dd>{planned.contextWindowTokens?.toLocaleString()}</dd>
              <dt className="text-text-secondary">{t('output')}</dt>
              <dd>{planned.maxOutputTokens?.toLocaleString()}</dd>
            </dl>
          )}
          {plannedMcp && (
            <>
              <pre className="max-h-56 overflow-auto rounded-lg bg-surface p-3 text-code">
                {JSON.stringify(plannedMcp.config, null, 2)}
              </pre>
              <p className="text-sm text-text-secondary">
                {t(plannedMcp.enableAfterImport ? 'mcp_enabled_notice' : 'mcp_disabled_notice')}
              </p>
            </>
          )}
          <p className="text-sm leading-6 text-text-secondary">
            {t(plannedAsset ? 'asset_notice' : plannedMcp ? 'mcp_private' : 'credentials')}
          </p>
          {plannedAsset && (
            <div className="space-y-2 rounded-lg bg-surface p-3 text-sm text-text-secondary">
              <p>{t(plannedAsset.projectScoped ? 'asset_project' : 'asset_global')}</p>
              <p>
                {t(
                  plannedAsset.nativeReference
                    ? 'asset_native'
                    : plannedAsset.enableAfterImport
                      ? 'asset_enabled'
                      : 'asset_disabled'
                )}
              </p>
            </div>
          )}
          {(['applying', 'cancel_requested'].includes(model.job?.job.status ?? '') ||
            (model.uncertainAction === 'apply' && !working)) && (
            <p role="status" className="text-sm text-text-secondary">
              {t('unknown')}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" disabled={working} onClick={() => void model.cancel()}>
              {t('cancel')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" disabled={working} onClick={() => void model.refresh()}>
                {t('refresh')}
              </Button>
              <Button disabled={working} onClick={() => void model.apply()}>
                {t(
                  ['applying', 'cancel_requested'].includes(model.job?.job.status ?? '') ||
                    (model.uncertainAction === 'apply' && !working)
                    ? 'retry'
                    : 'apply'
                )}
              </Button>
            </div>
          </div>
        </>
      )}
      {model.stage === 'result' && (
        <>
          {model.job &&
            plannedMcp &&
            Boolean(model.job.job.committedItems) &&
            (() => {
              const candidate = model.page.mcps?.find(value => value.itemId === plannedMcp.itemId)
              const id = `${model.job.job.jobId}:${plannedMcp.itemId}`
              if (
                !candidate ||
                (!(candidate.requiredEnv?.length ?? 0) && !(candidate.requiredHeaders?.length ?? 0))
              )
                return null
              return (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => setMcpCredentialFor(old => (old === id ? null : id))}
                  >
                    {t('mcp_credential.open')}
                  </Button>
                  {mcpCredentialFor === id && (
                    <MigrationMcpCredentialPanel
                      key={id}
                      deviceId={deviceId}
                      workspacePath={workspacePath}
                      isCurrent={isCurrent}
                      job={model.job}
                      itemId={plannedMcp.itemId}
                      candidate={candidate}
                      onUpdated={model.acceptUpdatedJob}
                      onBusy={setCredentialBusy}
                      onClose={() => setMcpCredentialFor(null)}
                    />
                  )}
                </>
              )
            })()}

          {model.job && model.job.plans[0] && Boolean(model.job.job.committedItems) && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={working}
                onClick={() => setCredentialOpen(old => !old)}
              >
                {t('credential.open')}
              </Button>
              {credentialOpen && (
                <MigrationCredentialPanel
                  deviceId={deviceId}
                  workspacePath={workspacePath}
                  isCurrent={isCurrent}
                  job={model.job}
                  itemId={model.job.plans[0].itemId}
                  onUpdated={model.acceptUpdatedJob}
                  onBusy={setCredentialBusy}
                  onClose={() => setCredentialOpen(false)}
                />
              )}
            </>
          )}
          <div className="flex items-center gap-2 text-base font-medium">
            <CheckCircle2 className="h-5 w-5 text-text-secondary" />
            {t(title)}
          </div>
          <p className="text-sm leading-6 text-text-secondary">
            {t(title === 'saved' ? 'saved_description' : `${title}_description`, {
              count: model.job?.job.committedItems ?? 0,
            })}
          </p>
          {model.job?.job.hasUnconfirmedOutcomes && (
            <p role="status" className="text-sm text-text-secondary">
              {t('unconfirmed_cancelled')}
            </p>
          )}
          {model.job?.job.status === 'completed_with_issues' && !plannedMcp && (
            <p className="text-sm text-text-secondary">{t('credentials')}</p>
          )}
          {plannedMcp && title === 'saved_mcp' && (
            <p className="text-sm text-text-secondary">
              {t(plannedMcp.enableAfterImport ? 'mcp_enabled_notice' : 'mcp_disabled_notice')}
            </p>
          )}
          {plannedAsset && title === 'saved_asset' && (
            <p className="text-sm text-text-secondary">
              {t(
                plannedAsset.nativeReference
                  ? 'asset_native'
                  : plannedAsset.enableAfterImport
                    ? 'asset_enabled'
                    : 'asset_disabled'
              )}
            </p>
          )}
          {model.job?.job.committedItems ? (
            <>
              <p className="text-xs leading-5 text-text-secondary">{t('rollback_description')}</p>
              <Button
                variant="outline"
                disabled={working || model.error === 'migration_rollback_ownership_unknown'}
                onClick={() => void model.rollback()}
              >
                {t(model.uncertainAction === 'rollback' ? 'retry' : 'rollback')}
              </Button>
            </>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-text-secondary">{t('details')}</summary>
            <div className="mt-2">{issues(model.page.items.flatMap(item => item.issues))}</div>
          </details>
          <Button variant="ghost" disabled={working} onClick={model.reset}>
            {t('back')}
          </Button>
        </>
      )}
      {working && (
        <div role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('busy')}
        </div>
      )}
    </section>
  )
}

function useBusy(busy: boolean, report: (value: boolean) => void) {
  useEffect(() => {
    report(busy)
    return () => report(false)
  }, [busy, report])
}
