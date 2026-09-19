import { Server } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import {
  readUsageStats,
  summarizeUsage,
  type UsageCounters,
  type UsageStats,
} from '@/kcoder/usageHistory'
import { IconSelect, SettingsPage, SettingsPageHeader } from './settings-ui'

import { UsageCharts } from './UsageCharts'

function compactTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: value < 10000 ? 'standard' : 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export function UsageSettingsPage() {
  const { t, i18n } = useTranslation('common')
  const label = (key: string) => t(`usageHistory.${key}`)
  const [servers, setServers] = useState<GatewayServer[]>([])
  const [serverId, setServerId] = useState('')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'daily' | 'models'>('daily')
  const [range, setRange] = useState<7 | 30>(30)
  const generation = useRef(0)
  useEffect(() => {
    let active = true
    void fetchGatewayServers()
      .then(items => {
        if (active) {
          setServers(items)
          setServerId(items[0]?.id ?? '')
        }
      })
      .catch(() => {
        if (active) setError(t('usageHistory.loadFailed'))
      })
    return () => {
      active = false
    }
  }, [t])
  const refresh = useCallback(async () => {
    if (!serverId) return
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await readUsageStats(serverId)
      if (current === generation.current) setStats(next)
    } catch (failure) {
      if (current === generation.current) {
        setStats(null)
        setError(failure instanceof Error ? failure.message : t('usageHistory.loadFailed'))
      }
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }, [serverId, t])
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [refresh])

  const locale = i18n.resolvedLanguage || 'zh-CN'
  // Time-range slicing + aggregation: the 7/30 day views share a single 30-day window.
  const view2 = useMemo(() => {
    if (!stats) return null
    const full = summarizeUsage(stats)
    if (range === 30) return full
    const daily = full.daily.slice(-range)
    const models = new Map<string, UsageCounters>()
    const total = daily.reduce(
      (accumulator, row) => {
        const scoped = { ...row } as UsageCounters
        delete (scoped as { label?: string }).label
        for (const key of Object.keys(accumulator) as (keyof UsageCounters)[]) {
          accumulator[key] += scoped[key]
        }
        for (const [model, usage] of Object.entries(stats.history?.days[row.label] ?? {})) {
          const summary =
            models.get(model) ??
            ({
              requests: 0,
              unreportedRequests: 0,
              estimatedTotalRequests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 0,
            } satisfies UsageCounters)
          for (const key of Object.keys(summary) as (keyof UsageCounters)[]) {
            summary[key] += usage[key] ?? 0
          }
          models.set(model, summary)
        }
        return accumulator
      },
      {
        requests: 0,
        unreportedRequests: 0,
        estimatedTotalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
      } satisfies UsageCounters
    )
    const modelRows = [...models.entries()]
      .map(([labelValue, counters]) => ({ label: labelValue, ...counters }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label))
    return { total, daily, models: modelRows }
  }, [stats, range])

  const summary = view2
  const activeDays = summary ? summary.daily.filter(row => row.requests > 0).length : 0
  const streak = useMemo(() => {
    if (!summary) return 0
    let count = 0
    for (let index = summary.daily.length - 1; index >= 0; index--) {
      if (summary.daily[index].requests > 0) count++
      else if (index !== summary.daily.length - 1) break
    }
    return count
  }, [summary])
  const topModel = summary?.models[0]
  const topModelShare =
    summary && topModel && summary.total.totalTokens > 0
      ? Math.round((topModel.totalTokens / summary.total.totalTokens) * 100)
      : 0
  const tableRows = summary
    ? view === 'daily'
      ? [...summary.daily].reverse()
      : summary.models
    : []
  const rangeButton = (value: 7 | 30, labelKey: string) => (
    <button
      type="button"
      aria-pressed={range === value}
      onClick={() => setRange(value)}
      data-testid={`usage-range-${value}`}
      className={`rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 max-md:min-h-11 aria-pressed:bg-background aria-pressed:font-medium aria-pressed:shadow-sm ${
        range === value ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label(labelKey)}
    </button>
  )
  const statCard = (labelKey: string, testId: string, content: React.ReactNode) => (
    <div className="border-b border-border/60 px-1 py-4">
      <p className="text-sm text-text-secondary">{label(labelKey)}</p>
      <div className="mt-2 heading-lg tabular-nums" data-testid={testId}>
        {content}
      </div>
    </div>
  )

  return (
    <SettingsPage data-testid="usage-settings-page">
      <SettingsPageHeader title={label('title')} description={label('description')} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">{label('range')}</span>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">{label('target')}</span>
            <IconSelect
              icon={<Server />}
              aria-label={label('target')}
              data-testid="usage-target"
              value={serverId}
              onChange={event => {
                generation.current++
                setStats(null)
                setError(null)
                setServerId(event.target.value)
              }}
            >
              {servers.length === 0 && <option value="">{label('noTargets')}</option>}
              {servers.map(server => (
                <option key={server.id} value={server.id}>
                  {server.label}
                </option>
              ))}
            </IconSelect>
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !serverId}
            onClick={() => void refresh()}
            data-testid="usage-refresh"
            className="max-md:min-h-11"
          >
            {busy ? label('loading') : label('refresh')}
          </Button>
          <div
            className="flex gap-1 rounded-lg bg-surface/60 p-1"
            role="group"
            aria-label={label('range')}
          >
            {rangeButton(7, 'range7')}
            {rangeButton(30, 'range30')}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-500">
          {error}
        </p>
      )}
      {busy && !stats && (
        <div
          aria-label={label('loading')}
          aria-busy="true"
          className="space-y-6"
          data-testid="usage-loading"
        >
          <div className="grid grid-cols-3 gap-4" aria-hidden="true">
            {[0, 1, 2].map(item => (
              <div
                key={item}
                className="h-24 animate-pulse rounded-xl bg-surface motion-reduce:animate-none"
              />
            ))}
          </div>
          <div
            aria-hidden="true"
            className="h-64 animate-pulse rounded-2xl bg-surface/60 motion-reduce:animate-none"
          />
        </div>
      )}
      {stats && summary && (
        <>
          <p className="mb-6 text-sm text-text-secondary" data-testid="usage-coverage">
            {stats.history
              ? t('usageHistory.coverage', {
                  date: new Date(stats.history.trackedSinceMs).toLocaleString(
                    i18n.resolvedLanguage
                  ),
                })
              : label('empty')}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-x-6 lg:grid-cols-3" data-testid="usage-summary">
            {statCard(
              'totalTokens',
              'usage-totalTokens',
              compactTokens(summary.total.totalTokens, locale)
            )}
            {statCard('requests', 'usage-requests', summary.total.requests.toLocaleString(locale))}
            {statCard(
              'ioTokens',
              'usage-ioTokens',
              <span className="text-lg">
                ↑ {compactTokens(summary.total.inputTokens, locale)} · ↓{' '}
                {compactTokens(summary.total.outputTokens, locale)}
              </span>
            )}
            {statCard('activeDays', 'usage-activeDays', activeDays)}
            {statCard('streakDays', 'usage-streakDays', streak)}
            {statCard(
              'topModel',
              'usage-topModel',
              <span className="text-lg">
                {topModel ? (
                  <>
                    <span className="break-all">{topModel.label}</span>
                    <span className="ml-2 text-sm text-text-secondary">
                      {label('share').replace('{{percent}}', String(topModelShare))}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </span>
            )}
          </div>
          {(summary.total.unreportedRequests > 0 || summary.total.estimatedTotalRequests > 0) && (
            <p role="status" className="mb-4 text-sm text-text-secondary">
              {t('usageHistory.partial', {
                missing: summary.total.unreportedRequests,
                estimated: summary.total.estimatedTotalRequests,
              })}
            </p>
          )}
          <UsageCharts
            key={`${serverId}:${range}`}
            stats={stats}
            daily={summary.daily}
            models={summary.models}
          />
          <div className="mb-3 flex gap-2" role="group" aria-label={label('grouping')}>
            {(['daily', 'models'] as const).map(key => (
              <Button
                key={key}
                size="sm"
                className="max-md:min-h-11"
                variant={view === key ? 'secondary' : 'ghost'}
                aria-pressed={view === key}
                onClick={() => setView(key)}
                data-testid={`usage-view-${key}`}
              >
                {label(key)}
              </Button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm" data-testid="usage-table">
              <thead className="bg-surface text-text-secondary">
                <tr>
                  <th className="px-3 py-3 font-medium">
                    {label(view === 'daily' ? 'date' : 'model')}
                  </th>
                  {[
                    'inputTokens',
                    'outputTokens',
                    'cacheReadTokens',
                    'cacheCreationTokens',
                    'totalTokens',
                  ].map(key => (
                    <th key={key} className="whitespace-nowrap px-3 py-3 text-right font-medium">
                      {label(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map(row => (
                  <tr
                    key={row.label}
                    className="border-t border-border/60 transition-colors hover:bg-surface/60 focus-within:bg-surface/60"
                  >
                    <td className="max-w-64 break-words px-3 py-2">{row.label}</td>
                    {(
                      [
                        'inputTokens',
                        'outputTokens',
                        'cacheReadTokens',
                        'cacheCreationTokens',
                        'totalTokens',
                      ] as const
                    ).map(key => (
                      <td key={key} className="px-3 py-2 text-right tabular-nums">
                        {row.requests ? row[key].toLocaleString() : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-text-secondary">{label('accounting')}</p>
        </>
      )}
    </SettingsPage>
  )
}
