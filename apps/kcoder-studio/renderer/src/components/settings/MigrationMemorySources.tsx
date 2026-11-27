import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { getRuntimeConfig } from '@/config/runtime'
import type { MigrationMemorySourcesResult, MigrationSourceKind } from '../../../../shared/generated/contracts'

class SourceLifetime {
  private generation = 0
  private running = false
  start() { if (this.running) return null; this.running = true; return ++this.generation }
  current(request: number) { return request === this.generation }
  finish() { this.running = false }
  dispose() { this.generation++; this.running = false }
}

export function MigrationMemorySources({ deviceId, workspacePath, isCurrent, onOpenBatch, onBusy }: {
  deviceId: string; workspacePath?: string; isCurrent: () => boolean; onOpenBatch: (id: string) => void; onBusy: (value: boolean) => void
}) {
  const { t } = useTranslation('migrationMemory')
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [page, setPage] = useState<MigrationMemorySourcesResult | null>(null)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]), [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [unknownScan, setUnknownScan] = useState(false)
  const lifetime = useMemo(() => new SourceLifetime(), [])
  useEffect(() => { return () => lifetime.dispose() }, [lifetime])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const perform = async (action: (valid: () => boolean) => Promise<void>, scan = false) => {
    if (!isCurrent()) return
    const request = lifetime.start()
    if (request === null) return
    const mount = getRuntimeConfig().appBasePath
    const valid = () => lifetime.current(request) && isCurrent() && mount === getRuntimeConfig().appBasePath
    setBusy(true); setError('')
    try { await action(valid) } catch (error) {
      if (valid()) { setError(error instanceof Error && error.message === 'migration_memory_update_required' ? 'updateRequired' : scan ? 'scanUnknown' : 'sourceFailed'); if (scan) setUnknownScan(true) }
    } finally { if (valid()) { lifetime.finish(); setBusy(false) } }
  }
  const turn = (direction: -1 | 1) => perform(async valid => {
    if (!page) return
    const nextIndex = index + direction, cursor = direction === 1 ? page.nextCursor ?? undefined : cursors[nextIndex]
    if (nextIndex < 0 || direction === 1 && !cursor) return
    const next = await api.memorySources({ catalogId: page.catalogId, ...(cursor ? { cursor } : {}) })
    if (!valid()) return
    if (direction === 1) setCursors(old => [...old.slice(0, nextIndex), cursor])
    setPage(next); setIndex(nextIndex)
  })
  return <section data-testid="migration-memory-sources" className="mt-4 space-y-3" aria-busy={busy}>
    <h3 className="text-base font-medium">{t('import')}</h3><p className="text-sm leading-6 text-text-secondary">{t('sourceBoundary')}</p>
    <div className="flex gap-2">{(['claude-code', 'codex'] as const).map(source => <Button key={source} size="sm" variant={kind === source ? 'secondary' : 'outline'} aria-pressed={kind === source} disabled={busy || unknownScan} onClick={() => { setKind(source); setPage(null); setIndex(0); setCursors([undefined]) }}>{source === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    <Button size="sm" disabled={busy || unknownScan} onClick={() => void perform(async valid => {
      const next = await api.memoryDiscover({ source: kind }); if (!valid()) return
      setPage(next); setIndex(0); setCursors([undefined])
    })}>{t('discover')}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{t(`errors.${error}`)}</p>}
    {page && <>
      {!page.items.length && <p className="text-sm text-text-secondary">{t('noSources')}</p>}
      <div className="studio-card divide-y divide-border rounded-lg border border-border">{page.items.map(source => <div key={source.sourceId} className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-3 py-3" data-testid="memory-source">
        <div className="min-w-0 text-sm"><p className="break-all">{source.sourceGroup}</p><p className="text-xs text-text-secondary">{t(`layouts.${source.layout}`)} · {t('sourceSize', { files: source.files, bytes: source.bytes })}</p>{source.blockedItems > 0 && <p className="text-xs text-text-secondary">{t('sourceBlocked', { count: source.blockedItems })}</p>}</div>
        <Button size="sm" variant="outline" disabled={busy || unknownScan || !source.files} onClick={() => void perform(async valid => {
          const job = await api.scanBatch({ sourceIds: [source.sourceId] })
          if (valid()) onOpenBatch(job.job.jobId)
        }, true)}>{t('openPreview')}</Button>
      </div>)}</div>
      <div className="flex justify-between"><Button size="sm" variant="ghost" disabled={busy || unknownScan || index === 0} onClick={() => void turn(-1)}>{t('previous')}</Button><span className="text-xs text-text-secondary">{t('page', { page: index + 1 })}</span><Button size="sm" variant="ghost" disabled={busy || unknownScan || !page.nextCursor} onClick={() => void turn(1)}>{t('next')}</Button></div>
      {!!page.problems.length && <p className="text-sm text-text-secondary">{t('sourceProblems', { count: page.problems.reduce((total, problem) => total + problem.count, 0) })}</p>}
      <details className="text-xs text-text-secondary"><summary className="cursor-pointer">{t('notObserved')}</summary><ul className="mt-2 list-disc pl-5">{page.unobserved.map(value => <li key={value}>{t(`unobserved.${value}`, { defaultValue: t('unobservedOther') })}</li>)}</ul></details>
    </>}
  </section>
}
