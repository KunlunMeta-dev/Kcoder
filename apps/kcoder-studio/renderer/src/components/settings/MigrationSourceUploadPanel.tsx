import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { createSourceUploadController } from '@/kcoder/migrationSourceUploadController'
import { inspectBrowserSourceUploadFiles, SOURCE_UPLOAD_MAX_SCAN_FILES } from '@/kcoder/migrationSourceUploadSelection'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind, SourceUploadState } from '../../../../shared/generated/contracts'

export function MigrationSourceUploadPanel({ target, isCurrent, onBusy, onUse, onIdentityChanged }: {
  target: GatewayServer; isCurrent: () => boolean; onBusy: (busy: boolean) => void; onUse?: (upload: SourceUploadState) => void;
  onIdentityChanged?: (id: string | null) => void
}) {
  const { t } = useTranslation('migrationUpload')
  const scope = migrationSourceRecoveryScope(target)
  const manager = useMemo(() => createSourceUploadController({ api: createMigrationApi(target.id, target.workspacePath), scope,
    storage: { get length() { return localStorage.length }, key: index => localStorage.key(index), getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    isCurrent: () => isCurrent() && scope === migrationSourceRecoveryScope(target) }), [target, scope, isCurrent])
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const [source, setSource] = useState<MigrationSourceKind | ''>(''), [mode, setMode] = useState<'files' | 'directory' | 'package'>('files')
  const [localError, setLocalError] = useState(''), [recordPage, setRecordPage] = useState(0)
  const [excluded, setExcluded] = useState({ private: 0, cache: 0 })
  const input = useRef<HTMLInputElement>(null)
  const upload = state.observed?.upload
  useEffect(() => { manager.activate(); return () => manager.dispose() }, [manager])
  useEffect(() => { onBusy(state.busy); return () => onBusy(false) }, [state.busy, onBusy])
  useEffect(() => { onIdentityChanged?.(state.unknown ? null : state.selector?.operationId ?? null) }, [state.selector?.operationId, state.unknown, onIdentityChanged])
  useEffect(() => {
    if (!upload || upload.workerState !== 'running' || state.busy || state.unknown) return
    const timer = window.setTimeout(() => void manager.read(), 1000)
    return () => window.clearTimeout(timer)
  }, [manager, state.busy, state.unknown, upload])
  const choose = async (files: File[]) => {
    setLocalError(''); setExcluded({ private: 0, cache: 0 })
    manager.clearSelected()
    const product = state.selector?.manifest.source ?? source
    try {
      if (!product) throw new Error('source product not selected')
      if (mode === 'package') {
        if (files.length !== 1) throw new Error('source_upload_file_count')
        await manager.selectPackage(product, files[0])
      } else {
        const selection = inspectBrowserSourceUploadFiles(mode, files)
        setExcluded(selection.excluded)
        if (!selection.files.length) { setLocalError('noSafeFiles'); return }
        await manager.selectFiles(product, selection.files)
      }
    } catch { setLocalError('selectionFailed') }
  }
  const selectedSource = state.selector?.manifest.source ?? source
  return <section data-testid="migration-source-upload" className="mt-4 space-y-3" aria-busy={state.busy}>
    <h3 className="text-base font-medium">{t('title')}</h3><p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="text-sm"><span className="mb-1 block">{t('source')}</span><SettingsSelect data-testid="source-upload-product" className="h-10 w-full rounded-lg border border-border bg-background px-3" value={selectedSource} disabled={state.busy || !!state.selector} onChange={event => { manager.newSelection(); setSource(event.target.value as MigrationSourceKind | '') }}><option value="">{t('chooseSource')}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option></SettingsSelect></label>
      <label className="text-sm"><span className="mb-1 block">{t('selectionMode')}</span><SettingsSelect data-testid="source-upload-mode" className="h-10 w-full rounded-lg border border-border bg-background px-3" value={mode} disabled={state.busy} onChange={event => { manager.clearSelected(); setMode(event.target.value as typeof mode); setLocalError(''); setExcluded({ private: 0, cache: 0 }) }}><option value="files">{t('files')}</option><option value="directory">{t('directory')}</option><option value="package">{t('package')}</option></SettingsSelect></label>
    </div>
    <p className="text-xs leading-5 text-text-secondary">{t(mode === 'directory' ? 'directoryHelp' : mode === 'package' ? 'packageHelp' : 'filesHelp')}</p>
    <input key={mode} ref={input} type="file" className="sr-only" data-testid="source-upload-input" disabled={state.busy} multiple={mode !== 'package'} {...(mode === 'directory' ? { webkitdirectory: '' } : {})} onChange={event => {
      const raw = event.currentTarget.files
      if (!raw || raw.length > SOURCE_UPLOAD_MAX_SCAN_FILES) { event.currentTarget.value = ''; manager.clearSelected(); setLocalError('rawFileCount'); return }
      const files = Array.from(raw); event.currentTarget.value = ''; void choose(files)
    }}/>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={state.busy || !selectedSource} onClick={() => input.current?.click()}>{t(state.selector ? 'reselect' : 'choose')}</Button>
      {!state.selector && <Button size="sm" disabled={state.busy || !state.selected} onClick={() => void manager.start()}>{t('start')}</Button>}
      {state.selector && <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void manager.read()}>{t('read')}</Button>}
      {state.selector && !upload && state.readAttempted && <Button size="sm" variant="outline" disabled={state.busy || !state.selected} onClick={() => void manager.retryPrepare()}>{t('retryPrepare')}</Button>}
      {state.selector && upload?.stage !== 'ready' && <Button size="sm" disabled={state.busy || !state.selected || upload?.workerState !== 'stopped'} onClick={() => void manager.resume()}>{t('resume')}</Button>}
      {(state.busy || state.selector && upload?.stage !== 'ready') && <Button size="sm" variant="outline" onClick={() => void manager.cancel()}>{t('cancel')}</Button>}
      {state.selector && <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => { setSource(selectedSource); manager.newSelection(); setLocalError('') }}>{t('newSelection')}</Button>}
    </div>
    {(state.error || localError) && <p role="alert" className="text-sm text-destructive">{t(`errors.${localError || state.error}`)}</p>}
    {excluded.private + excluded.cache > 0 && <div role="status" data-testid="source-upload-exclusions" className="space-y-1 text-xs leading-5 text-text-secondary"><p>{t('excludedBoundary')}</p>{excluded.private > 0 && <p>{t('excludedPrivate', { count: excluded.private })}</p>}{excluded.cache > 0 && <p>{t('excludedCache', { count: excluded.cache })}</p>}</div>}
    {state.hashing && <p role="status" className="text-sm text-text-secondary">{mode === 'package' ? t('packageProgress') : t('hashProgress', { bytes: state.hashedBytes.toLocaleString(), total: state.hashTotalBytes.toLocaleString() })}</p>}
    {state.selected && <p className="text-sm text-text-secondary">{t('selected', { files: state.selected.files.length, bytes: state.selected.manifest.files.reduce((sum, file) => sum + file.bytes, 0).toLocaleString() })}</p>}
    {upload && <div className="studio-card-spacing space-y-2 rounded-lg border border-border" data-testid="source-upload-status">
      <p className="text-sm font-medium">{t(`stages.${upload.stage}`)}</p>
      <p className="text-sm text-text-secondary">{t('progress', { received: upload.receivedBytes.toLocaleString(), verified: upload.verifiedBytes.toLocaleString(), total: upload.totalBytes.toLocaleString() })}</p>
      <p className="text-xs text-text-secondary">{t(`workers.${upload.workerState}`)}</p>
      {state.unknown && <p className="text-sm text-text-secondary">{t('unknown')}</p>}
      <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void manager.files()}>{t('fileProgress')}</Button>
      {upload.stage === 'ready' && !state.unknown && <><p className="text-sm leading-6 text-text-secondary">{t('readyBoundary')}</p>{!onUse && <p className="text-sm text-text-secondary">{t('useUnavailable')}</p>}<Button size="sm" disabled={state.busy || !onUse} onClick={() => { if (isCurrent()) onUse?.(upload) }}>{t('useReady')}</Button></>}
    </div>}
    {state.files && <div className="studio-card-spacing space-y-2 rounded-lg border border-border"><ul className="space-y-2 text-sm">{state.files.page.files.map(file => <li key={file.fileIndex} className="break-all">{state.selector?.manifest.files[file.fileIndex]?.relativePath} · {file.acceptedBytes.toLocaleString()} {t(file.complete ? 'fileComplete' : 'fileIncomplete')}</li>)}</ul><div className="flex justify-between"><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void manager.files()}>{t('firstFiles')}</Button><Button size="sm" variant="ghost" disabled={state.busy || state.files.page.nextCursor == null} onClick={() => void manager.files(state.files!.page.nextCursor!)}>{t('nextFiles')}</Button></div></div>}
    {state.cached.length > 0 && <details className="studio-card-spacing rounded-lg border border-border text-sm" data-testid="source-upload-records"><summary className="cursor-pointer">{t('records')}</summary><p className="mt-2 text-xs leading-5 text-text-secondary">{t('recordsBoundary')}</p>
      <ul className="my-2 divide-y divide-border">{state.cached.slice(recordPage * 10, recordPage * 10 + 10).map(record => <li key={record.operationId} data-testid={`source-upload-record-${record.operationId}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"><span>{record.manifest.source === 'codex' ? 'Codex' : 'Claude Code'} · {record.operationId.slice(0, 8)} · {t('recordFiles', { count: record.manifest.files.length })}</span><Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void manager.restore(record.operationId)}>{t('readRecord')}</Button></li>)}</ul>
      <div className="flex justify-between"><Button size="sm" variant="ghost" disabled={state.busy || recordPage === 0} onClick={() => setRecordPage(value => value - 1)}>{t('previous')}</Button><span className="text-xs text-text-secondary">{t('page', { page: recordPage + 1 })}</span><Button size="sm" variant="ghost" disabled={state.busy || (recordPage + 1) * 10 >= state.cached.length} onClick={() => setRecordPage(value => value + 1)}>{t('next')}</Button></div>
    </details>}
  </section>
}
