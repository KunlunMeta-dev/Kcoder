import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useMemo, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { OfficeArtifactRef, OfficeDatasetPage, OfficeTaskRef } from '../../../../shared/generated/contracts.js'
import { isOfficeDatasetPage } from '../../../../shared/generated/contractGuards.mjs'
import { OfficeController } from './controller'
import { OfficeErrorNotice } from './OfficeErrorNotice'
import { OfficeDatasetChart, type OfficeChartOptions } from './OfficeDatasetChart'
type ExactPage = OfficeDatasetPage & { numberText?: (string | null)[][]; aggregates?: { key: string; value: string | null; nonNullCount: number }[] }
export function OfficeDatasetView({ controller, reference, chart = false, chartOptions, task, onExportReady }: { controller: OfficeController; reference: OfficeArtifactRef; chart?: boolean; chartOptions?: OfficeChartOptions; task?: OfficeTaskRef; onExportReady?: (receipt: unknown) => void }) {
  const { t } = useTranslation('officeIntegration')
  const [page, setPage] = useState<ExactPage | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(true)
  const [sort, setSort] = useState('')
  const [filter, setFilter] = useState('')
  const [applied, setApplied] = useState({ sort: '', filter: '' })
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const current = useRef<AbortController | null>(null)
  const scope = controller.scopeKey()
  const resetOwner = useMemo(() => ({}), [scope, reference.id, reference.revision])
  const [previousOwner, setPreviousOwner] = useState(resetOwner)
  if (previousOwner !== resetOwner) { setPreviousOwner(resetOwner); setPage(null); setCursors([undefined]); setApplied({ sort: '', filter: '' }); setFilter(''); setSort('') }
  const queryOwner = useMemo(() => ({}), [controller, reference.id, reference.revision, scope, applied, cursors])
  const [previousQuery, setPreviousQuery] = useState(queryOwner)
  if (previousQuery !== queryOwner) { setPreviousQuery(queryOwner); setBusy(true) }
  useEffect(() => {
    const abort = new AbortController(); current.current = abort
    const query = { limit: 10, columns: [], sort: applied.sort ? [{ column: applied.sort, descending: false }] : [],
      filters: applied.filter && page?.columns.find(column => column.kind === 'string') ? [{ column: page.columns.find(column => column.kind === 'string')!.key, operator: 'contains', value: applied.filter }] : [], ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}) }
    void controller.call<Record<string, unknown>>('dataset/page', { reference, query }, undefined, abort.signal).then(result => {
      if (abort.signal.aborted) return
      if (!isOfficeDatasetPage(result)) throw new Error('OFFICE_INVALID_REPLY')
      setPage(result as ExactPage); setError(null)
    }).catch(error => { if (!abort.signal.aborted) setError(error) }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
    // Column metadata is immutable for a reference. Query state, not returned rows,
    // owns fetching; a read result cannot start a self-refreshing request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, reference.id, reference.revision, scope, applied, cursors])

  const cell = (value: unknown, row: number, column: number) => value === null ? t('null') : page?.numberText?.[row]?.[column] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value))
  return <div className="min-w-0 space-y-3">
    {error ? <OfficeErrorNotice error={error} onClose={() => setError(null)} /> : null}
    {page && <><form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setCursors([undefined]); setApplied({ sort, filter }) }}>
      <label className="space-y-1 text-sm">{t('sort')}<SettingsSelect value={sort} onChange={event => setSort(event.target.value)} className="block min-h-11 rounded-lg border border-border bg-background px-3 text-base"><option value="">{t('all')}</option>{page.columns.map(column => <option key={column.key} value={column.key}>{column.title}</option>)}</SettingsSelect></label>
      <label className="space-y-1 text-sm">{t('filter')}<input value={filter} onChange={event => setFilter(event.target.value)} className="block min-h-11 rounded-lg border border-border bg-background px-3 text-base" /></label><Button type="submit" variant="outline" disabled={busy}>{t('apply')}</Button>
    </form>
      {chart ? <OfficeDatasetChart columns={page.columns} rows={page.rows} options={chartOptions} /> : null}
      <div className="studio-card overflow-x-auto rounded-lg border border-border"><table className="w-full border-collapse text-left text-base"><thead className="bg-surface"><tr>{page.columns.map(column => <th key={column.key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{column.title}{column.unit ? ` (${column.unit})` : ''}</th>)}</tr></thead><tbody>{page.rows.map((row, index) => <tr key={index} className="border-t border-border">{row.map((value, column) => <td key={page.columns[column].key} className="max-w-sm break-words px-3 py-2">{cell(value, index, column)}</td>)}</tr>)}</tbody></table></div>
      <p className="text-sm text-text-secondary">{t('rows', { shown: page.rows.length, total: page.totalRows })} · {t('filtered', { count: page.matchedRows })}</p>
      {page.aggregates?.length ? <dl className="flex flex-wrap gap-4 text-base">{page.aggregates.map(aggregate => <div key={aggregate.key}><dt className="text-text-secondary">{aggregate.key}</dt><dd>{aggregate.value ?? t('null')}</dd></div>)}</dl> : null}
      {onExportReady && task && <div className="flex flex-wrap gap-2">{(['csv','json'] as const).map(format => <Button key={format} variant="outline" disabled={busy} onClick={() => { setBusy(true); void controller.call('dataset/export', { reference, format, task }, controller.operation()).then(result => onExportReady(result.export)).catch(setError).finally(() => setBusy(false)) }}>{t(format === 'csv' ? 'exportCsv' : 'exportJson')}</Button>)}</div>}
      <nav className="flex gap-2"><Button variant="ghost" disabled={busy || cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>{t('previous')}</Button><Button variant="ghost" disabled={busy || !page.nextCursor} onClick={() => { if (page.nextCursor) setCursors([...cursors, page.nextCursor]) }}>{t('next')}</Button></nav>
    </>}
    {busy && <p role="status" className="text-sm text-text-secondary">{t('loading')}</p>}
  </div>
}
