import { Checkbox } from '@/components/ui/checkbox'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Clock,
  Database,
  FileText,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import { gatewayServerLabel } from '@/kcoder/gatewayServerLabel'
import {
  cleanStorage,
  cancelStorageScan,
  disableDebugLog,
  readStorageReport,
  type StorageReport,
} from '@/kcoder/storageDiagnostics'
import {
  readTurnFileChangesPolicy,
  saveTurnFileChangesPolicy,
  type TurnFileChangesPolicy,
} from '@/kcoder/turnFileChanges'
import { useTranslation } from '@/hooks/useTranslation'

import {
  IconSelect,
  InputWithIcon,
  SectionHeader,
  SettingsPage,
  SettingsPageHeader,
  StatusChip,
} from './settings-ui'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function StorageSettingsPage() {
  const { t, i18n } = useTranslation('common')
  const [serverId, setServerId] = useState('')
  const [report, setReport] = useState<StorageReport | null>(null)
  /** The runtime target and account the shown report actually came from. */
  const [reportTarget, setReportTarget] = useState<GatewayServer | null>(null)
  const servers = useRef<GatewayServer[]>([])
  const [targets, setTargets] = useState<GatewayServer[]>([])
  const scanGeneration = useRef(0)
  const activeScan = useRef<{ id: string; serverId: string; epoch: number } | null>(null)
  const scopeEpoch = useRef(0)
  const [scopeVersion, setScopeVersion] = useState(0)
  const [scopeReady, setScopeReady] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [policy, setPolicy] = useState<TurnFileChangesPolicy | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [cleanCandidate, setCleanCandidate] = useState<{
    id: string
    name: string
    bytes: number
    epoch: number
    serverId: string
  } | null>(null)
  const cleanOpener = useRef<HTMLButtonElement | null>(null)
  const [cleanError, setCleanError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const label = useCallback(
    (key: string, options?: Record<string, unknown>) => t(`storageSettings.${key}`, options),
    [t]
  )

  const invalidateScope = useCallback(() => {
    scopeEpoch.current += 1
    scanGeneration.current += 1
    activeScan.current = null
    setReport(null)
    setReportTarget(null)
    setPolicy(null)
    setCleanCandidate(null)
    setSelectedBucket(null)
    setCleanError(null)
    setError(null)
    setNotice(null)
    setBusy(false)
    setMutating(false)
  }, [])

  useEffect(() => {
    let disposed = false
    let discovery = 0
    const load = async (changed = false) => {
      const current = ++discovery
      if (changed) {
        invalidateScope()
        setScopeReady(false)
        servers.current = []
        setTargets([])
      }
      try {
        const items = await fetchGatewayServers()
        if (disposed || current !== discovery) return
        servers.current = items
        setTargets(items)
        setScopeReady(true)
        setServerId(previous =>
          items.some(server => server.id === previous) ? previous : (items[0]?.id ?? '')
        )
        if (changed) setScopeVersion(value => value + 1)
      } catch {
        if (!disposed && current === discovery)
          setError(label('loadFailed', { message: 'gateway servers unavailable' }))
      }
    }
    void load()
    const changed = () => {
      void load(true)
    }
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      disposed = true
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [label, invalidateScope])

  const refresh = useCallback(async () => {
    if (!serverId) return
    // A scan can be re-issued while an earlier one is still in flight: the
    // target or the locale can change under it, and the disabled state only
    // guards the refresh button. Without a generation check the slower response
    // wins and the page reports another target's totals — U5 requires a late
    // scan never to overwrite the current data.
    const generation = ++scanGeneration.current
    const scan = { id: crypto.randomUUID(), serverId, epoch: scopeEpoch.current }
    activeScan.current = scan
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await readStorageReport(serverId, scan.id)
      if (generation !== scanGeneration.current) return
      setReport(next)
      setReportTarget(servers.current.find(server => server.id === serverId) ?? null)
    } catch (failure) {
      if (generation !== scanGeneration.current) return
      setError(
        label('loadFailed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
      )
      setReport(null)
      setReportTarget(null)
    } finally {
      if (generation === scanGeneration.current) {
        activeScan.current = null
        setBusy(false)
      }
    }
  }, [serverId, label])

  const cancelScan = async () => {
    const scan = activeScan.current
    if (!scan) return
    scanGeneration.current += 1
    activeScan.current = null
    setBusy(false)
    try {
      await cancelStorageScan(scan.serverId, scan.id)
      if (scan.epoch === scopeEpoch.current) setNotice(label('scanCancelled'))
    } catch (failure) {
      if (scan.epoch === scopeEpoch.current)
        setError(
          label('scanCancelFailed', {
            message: failure instanceof Error ? failure.message : String(failure),
          })
        )
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh, scopeVersion])

  useEffect(() => {
    if (!serverId) return
    let cancelled = false
    const epoch = scopeEpoch.current
    void readTurnFileChangesPolicy(serverId)
      .then(loaded => {
        if (!cancelled && epoch === scopeEpoch.current) setPolicy(loaded)
      })
      .catch(() => {
        if (!cancelled && epoch === scopeEpoch.current) setPolicy(null)
      })
    return () => {
      cancelled = true
    }
  }, [serverId, scopeVersion])

  const savePolicy = async () => {
    if (!policy) return
    const epoch = scopeEpoch.current
    setMutating(true)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await saveTurnFileChangesPolicy(serverId, policy)
      if (epoch !== scopeEpoch.current) return
      setPolicy(saved)
      setNotice(label('policySaved'))
    } catch (failure) {
      if (epoch !== scopeEpoch.current) return
      setError(
        label('cleanFailed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
      )
    } finally {
      if (epoch === scopeEpoch.current) {
        setBusy(false)
        setMutating(false)
      }
    }
  }

  const mib = (bytes: number) => Math.max(0, Math.round(bytes / (1024 * 1024)))
  const fromMib = (value: string) => Math.max(0, Math.round(Number(value) || 0)) * 1024 * 1024

  const closeClean = () => {
    setCleanCandidate(null)
    setCleanError(null)
    window.setTimeout(() => {
      if (cleanOpener.current?.isConnected) cleanOpener.current.focus()
      else document.querySelector<HTMLButtonElement>('[data-testid="storage-refresh"]')?.focus()
    }, 0)
  }

  const clean = async () => {
    if (
      !cleanCandidate ||
      busy ||
      cleanCandidate.epoch !== scopeEpoch.current ||
      cleanCandidate.serverId !== serverId
    )
      return
    const bucketId = cleanCandidate.id
    // Any scan still in flight describes the pre-clean state, so it must not be
    // allowed to land on top of the post-clean report below.
    scanGeneration.current += 1
    setCleanError(null)
    const epoch = scopeEpoch.current
    setMutating(true)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await cleanStorage(serverId, bucketId)
      if (epoch !== scopeEpoch.current) return
      setReport(result.report)
      closeClean()
      setNotice(
        label('cleaned', { bytes: formatBytes(result.removedBytes), files: result.removedFiles })
      )
      if (result.errors?.length)
        setError(label('cleanPartial', { message: result.errors.join('; ') }))
    } catch (failure) {
      if (epoch !== scopeEpoch.current) return
      setCleanError(
        failure && typeof failure === 'object' && 'code' in failure && failure.code === -32034
          ? label('cleanBusy')
          : label('cleanFailed', {
              message: failure instanceof Error ? failure.message : String(failure),
            })
      )
    } finally {
      if (epoch === scopeEpoch.current) {
        setBusy(false)
        setMutating(false)
      }
    }
  }

  const disable = async () => {
    const epoch = scopeEpoch.current
    setMutating(true)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await disableDebugLog(serverId)
      if (epoch !== scopeEpoch.current) return
      setNotice(label('disabled', { note: result.note }))
      await refresh()
    } catch (failure) {
      if (epoch !== scopeEpoch.current) return
      setError(
        label('cleanFailed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
      )
    } finally {
      if (epoch === scopeEpoch.current) {
        setBusy(false)
        setMutating(false)
      }
    }
  }

  const bucketLabel = (id: string) => label(`bucket_${id.replace(/-/g, '_')}`)

  return (
    <SettingsPage className="space-y-6" data-testid="storage-settings-page">
      <SettingsPageHeader
        title={label('title')}
        description={label('description')}
        actions={
          <div className="flex items-center gap-2">
            {busy && !mutating && (
              <Button
                data-testid="storage-cancel-scan"
                variant="outline"
                onClick={() => void cancelScan()}
              >
                {label('cancelScan')}
              </Button>
            )}
            <Button
              data-testid="storage-refresh"
              variant="outline"
              disabled={busy || !serverId || !scopeReady}
              onClick={() => void refresh()}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {label('refresh')}
            </Button>
          </div>
        }
      />
      <label className="block space-y-2 text-sm">
        <span>{label('target')}</span>
        <IconSelect
          data-testid="storage-target"
          icon={<Database className="h-4 w-4" />}
          value={serverId}
          disabled={mutating || !scopeReady || targets.length === 0}
          onChange={event => {
            invalidateScope()
            setServerId(event.target.value)
          }}
        >
          {targets.map(server => (
            <option key={server.id} value={server.id}>
              {gatewayServerLabel(server, t)}
            </option>
          ))}
        </IconSelect>
      </label>
      {busy && !report && (
        <div
          aria-busy="true"
          aria-label={label('refresh')}
          className="h-44 animate-pulse rounded-2xl bg-surface motion-reduce:animate-none"
        />
      )}
      {report && (
        <section
          className="rounded-2xl border border-border/60 bg-surface/30 p-5"
          aria-label={label('overview')}
        >
          {/* U5: the totals are meaningless without saying which target and
              account they were measured on. The config root is already shown
              by the summary line below, so it is not repeated here. */}
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span data-testid="storage-scan-completeness">
              {label(
                report.partial === undefined
                  ? 'scanCompletenessUnknown'
                  : report.partial
                    ? 'scanPartial'
                    : 'scanComplete'
              )}
            </span>
            <span data-testid="storage-scan-time">
              {report.scannedAt
                ? label('scannedAt', {
                    time: new Date(report.scannedAt).toLocaleString(i18n.language),
                  })
                : label('scanTimeUnknown')}
            </span>
            <span data-testid="storage-scan-target">
              {label('scanTarget', {
                target: reportTarget ? gatewayServerLabel(reportTarget, t) : serverId,
              })}
            </span>
            {reportTarget?.accountIdentity && (
              <span data-testid="storage-scan-account">
                {label('scanAccount', {
                  account: `${reportTarget.accountIdentity.username} · ${reportTarget.accountIdentity.role}`,
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm text-text-secondary">{label('usedSpace')}</p>
              <p className="mt-2 heading-lg tabular-nums">{formatBytes(report.totalBytes)}</p>
            </div>
            <div className="flex gap-8">
              <div>
                <p className="text-xs text-text-secondary">{label('cleanableSpace')}</p>
                <p className="mt-2 text-lg font-medium tabular-nums">
                  {formatBytes(
                    report.buckets
                      .filter(bucket => bucket.cleanable)
                      .reduce((sum, bucket) => sum + bucket.bytes, 0)
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-secondary">{label('fileCount')}</p>
                <p className="mt-2 text-lg font-medium tabular-nums">
                  {report.totalFiles.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
          <div
            className="mt-5 flex h-7 gap-1 overflow-hidden rounded-lg bg-text-muted/5"
            role="group"
            aria-label={label('distribution')}
            data-testid="storage-distribution"
          >
            {report.buckets
              .filter(bucket => bucket.bytes > 0)
              .map((bucket, index) => (
                <button
                  key={bucket.id}
                  type="button"
                  aria-label={`${bucketLabel(bucket.id)} · ${formatBytes(bucket.bytes)}`}
                  title={`${bucketLabel(bucket.id)} · ${formatBytes(bucket.bytes)}`}
                  aria-pressed={selectedBucket === bucket.id}
                  onClick={() =>
                    setSelectedBucket(current => (current === bucket.id ? null : bucket.id))
                  }
                  style={{ flexGrow: bucket.bytes, flexBasis: 0 }}
                  className={`min-w-6 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${['bg-slate-400/80', 'bg-blue-500/65', 'bg-violet-400/60', 'bg-slate-500/50'][index % 4]}`}
                />
              ))}
          </div>
          <p className="mt-3 text-xs text-text-secondary">{label('cleanableHint')}</p>
          <p
            data-testid="storage-total"
            className="mt-4 break-all border-t border-border/60 pt-3 text-xs text-text-secondary"
          >
            {label('total', {
              size: formatBytes(report.totalBytes),
              files: report.totalFiles,
              root: report.configRoot,
            })}
          </p>
        </section>
      )}

      {error && (
        <div
          data-testid="storage-error"
          role="alert"
          className="rounded-xl border border-red-500/15 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          data-testid="storage-notice"
          role="status"
          className="rounded-xl border border-border/60 bg-surface/50 px-4 py-3 text-sm text-text-secondary"
        >
          {notice}
        </div>
      )}

      {report && (
        <>
          <section className="space-y-4 rounded-2xl border border-border/60 bg-surface/20 p-5">
            <SectionHeader
              icon={<HardDrive />}
              title={label('bucketsTitle')}
              description={label('bucketHint')}
            />
            <ul className="divide-y divide-border/60">
              {report.buckets.map(bucket => (
                <li
                  key={bucket.id}
                  data-testid={`storage-bucket-${bucket.id}`}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-4 transition-colors ${selectedBucket === bucket.id ? 'bg-surface ring-1 ring-focus/30' : 'hover:bg-surface/50'}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-text-secondary">
                      <Database className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{bucketLabel(bucket.id)}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {bucket.files.toLocaleString()} {label('files')}
                      </p>
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-4">
                    <span className="text-sm font-medium tabular-nums">
                      {formatBytes(bucket.bytes)}
                    </span>
                    {!bucket.cleanable && <StatusChip>{label('preserved')}</StatusChip>}
                    {bucket.cleanable && (
                      <Button
                        data-testid={`storage-clean-${bucket.id}`}
                        variant="outline"
                        disabled={busy || bucket.bytes === 0}
                        onClick={event => {
                          cleanOpener.current = event.currentTarget
                          setCleanError(null)
                          setCleanCandidate({
                            id: bucket.id,
                            name: bucketLabel(bucket.id),
                            bytes: bucket.bytes,
                            epoch: scopeEpoch.current,
                            serverId,
                          })
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                        {label('clean')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {policy && (
            <section className="space-y-5 rounded-2xl border border-border/60 bg-surface/20 p-5">
              <SectionHeader
                icon={<Archive />}
                title={label('policyTitle')}
                description={label('policyDescription')}
              />
              <label className="flex items-center gap-3 rounded-xl bg-surface/50 px-4 py-3 text-sm">
                <Checkbox
                  data-testid="policy-enabled"
                  className="h-4 w-4 accent-text-primary"
                  disabled={busy}
                  checked={policy.enabled}
                  onChange={event => setPolicy({ ...policy, enabled: event.target.checked })}
                />
                {label('policyEnabled')}
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm">
                  {label('policyRetention')}
                  <InputWithIcon
                    icon={<Clock className="h-4 w-4" />}
                    disabled={busy}
                    data-testid="policy-retention-days"
                    type="number"
                    min={0}
                    value={policy.retentionDays}
                    onChange={event =>
                      setPolicy({
                        ...policy,
                        retentionDays: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                  />
                </label>
                <label className="block text-sm">
                  {label('policyTotalCap')}
                  <InputWithIcon
                    icon={<HardDrive className="h-4 w-4" />}
                    disabled={busy}
                    data-testid="policy-max-total-mib"
                    type="number"
                    min={0}
                    value={mib(policy.maxTotalBytes)}
                    onChange={event =>
                      setPolicy({ ...policy, maxTotalBytes: fromMib(event.target.value) })
                    }
                  />
                </label>
                <label className="block text-sm">
                  {label('policyFileCap')}
                  <InputWithIcon
                    icon={<HardDrive className="h-4 w-4" />}
                    disabled={busy}
                    data-testid="policy-max-file-mib"
                    type="number"
                    min={0}
                    value={mib(policy.maxFileBytes)}
                    onChange={event =>
                      setPolicy({ ...policy, maxFileBytes: fromMib(event.target.value) })
                    }
                  />
                </label>
              </div>
              <label className="block text-sm">
                {label('policyIgnoreGlobs')}
                <textarea
                  data-testid="policy-ignore-globs"
                  disabled={busy}
                  className="mt-2 block min-h-24 w-full rounded-xl border border-border bg-background p-3 text-code text-text-primary shadow-sm outline-none transition-colors focus:border-focus/60 focus:ring-2 focus:ring-focus/15"
                  value={policy.ignoreGlobs.join('\n')}
                  onChange={event =>
                    setPolicy({
                      ...policy,
                      ignoreGlobs: event.target.value
                        .split('\n')
                        .map(line => line.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <Button data-testid="policy-save" disabled={busy} onClick={() => void savePolicy()}>
                <ShieldCheck aria-hidden="true" />
                {label('policySave')}
              </Button>
            </section>
          )}

          <section className="space-y-4 rounded-2xl border border-border/60 bg-surface/20 p-5">
            <SectionHeader icon={<KeyRound />} title={label('credentialsTitle')} />
            <p className="text-xs text-text-secondary" data-testid="credentials-keyring">
              {report.credentials.keyringAvailable
                ? label('keyringAvailable', { backend: report.credentials.keyringBackend })
                : label('keyringUnavailable', { backend: report.credentials.keyringBackend })}
            </p>
            {report.credentials.keyringProviders.length > 0 && (
              <p className="text-xs text-text-secondary">
                {label('keyringProvidersInUse', {
                  providers: report.credentials.keyringProviders.join(', '),
                })}
              </p>
            )}
            {report.credentials.plaintextProviders.length > 0 && (
              <p
                className="text-xs text-amber-600 dark:text-amber-500"
                data-testid="credentials-plaintext"
              >
                {label('plaintextProviders', {
                  providers: report.credentials.plaintextProviders.join(', '),
                })}
                {report.credentials.keyringAvailable
                  ? ` — ${label('keyringMigrationHint')}`
                  : ` — ${label('keyringUnavailableHint')}`}
              </p>
            )}
            <p data-testid="storage-credentials" className="text-sm text-text-secondary">
              {report.credentials.present
                ? label('credentialsPlaintext', {
                    path: report.credentials.path,
                    providers: report.credentials.providers,
                  })
                : label('credentialsMissing', { path: report.credentials.path })}
            </p>
            <p className="text-xs text-text-secondary">
              {report.credentials.userOnly === true
                ? label('credentialsUserOnly')
                : report.credentials.userOnly === false
                  ? label('credentialsShared')
                  : label('credentialsUnknown')}
            </p>
            {report.credentials.dotenvCredentialLines > 0 && (
              <p data-testid="storage-credentials-dotenv" className="text-xs text-amber-600">
                {label('credentialsDotenv', { count: report.credentials.dotenvCredentialLines })}
              </p>
            )}
            <p className="text-xs text-text-secondary">{label('credentialsGuidance')}</p>
          </section>

          <section className="space-y-4 rounded-2xl border border-border/60 bg-surface/20 p-5">
            <SectionHeader icon={<FileText />} title={label('devDebugTitle')} />
            <p
              data-testid="storage-dev-debug"
              className={`text-sm ${report.devDebug.enabled ? 'text-amber-600' : 'text-text-secondary'}`}
            >
              {report.devDebug.enabled
                ? label('devDebugOn', {
                    size: formatBytes(report.devDebug.logBytes),
                    files: report.devDebug.logFiles,
                    oldest: report.devDebug.oldestDay ?? '-',
                  })
                : label('devDebugOff')}
            </p>
            {report.devDebug.enabled && (
              <>
                <p className="text-xs text-text-secondary">
                  {label('retention', { days: report.devDebug.retentionDays })}
                </p>
                {report.devDebug.envSet && (
                  <p data-testid="storage-env-warning" className="text-xs text-amber-600">
                    {label('envWarning')}
                  </p>
                )}
                <Button
                  data-testid="storage-disable-debug"
                  disabled={busy}
                  onClick={() => void disable()}
                >
                  {label('disable')}
                </Button>
              </>
            )}
          </section>
        </>
      )}
      {cleanCandidate && (
        <RuntimeTargetConfirmDialog
          testId="storage-clean-dialog"
          title={label('cleanTitle', { name: cleanCandidate.name })}
          description={label('cleanConfirm', { name: cleanCandidate.name })}
          cancelLabel={label('cancel')}
          closeLabel={label('cancel')}
          confirmLabel={label('clean')}
          destructive
          pending={busy}
          error={cleanError ?? undefined}
          onCancel={closeClean}
          onConfirm={() => void clean()}
        >
          <div className="rounded-xl bg-surface p-4">
            <p className="text-xs text-text-secondary">{label('selectedSize')}</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {formatBytes(cleanCandidate.bytes)}
            </p>
            <p className="mt-2 text-xs text-text-secondary">{label('cleanableHint')}</p>
          </div>
        </RuntimeTargetConfirmDialog>
      )}
    </SettingsPage>
  )
}
