import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { type UsageCounters, type UsageStats } from '@/kcoder/usageHistory'
import { Button } from '@/components/ui/button'

import { usageCalendar } from './usage-chart-calendar'
type Day = UsageCounters & { label: string }
const COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-slate-400']
const HEAT = [
  'bg-text-muted/10',
  'bg-blue-500/20',
  'bg-blue-500/40',
  'bg-blue-500/65',
  'bg-blue-500',
]

function moveDate(event: KeyboardEvent<HTMLDivElement>, step: number) {
  const offset = { ArrowRight: step, ArrowLeft: -step, ArrowDown: 1, ArrowUp: -1 }[event.key]
  if (offset === undefined && event.key !== 'Home' && event.key !== 'End') return
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-date]')
  )
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : Math.max(0, Math.min(buttons.length - 1, index + (offset ?? 0)))
  buttons[next]?.focus()
}

export function UsageCharts({
  stats,
  daily,
  models,
}: {
  stats: UsageStats
  daily: Day[]
  models: Day[]
}) {
  const { t, i18n } = useTranslation('common')
  const text = (key: string) => t(`usageHistory.${key}`)
  const locale = i18n.resolvedLanguage || 'zh-CN'
  const number = (value: number) => value.toLocaleString(locale)
  const [pinned, setPinned] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [focusedDate, setFocusedDate] = useState<string | null>(null)
  const [interaction, setInteraction] = useState<'pointer' | 'keyboard'>('pointer')
  const [hidden, setHidden] = useState<string[]>([])
  const calendar = usageCalendar(stats, daily)
  const heatmapViewport = useRef<HTMLDivElement>(null)
  const trendViewport = useRef<HTMLDivElement>(null)
  const lastDate = calendar.at(-1)?.label
  useLayoutEffect(() => {
    for (const viewport of [heatmapViewport.current, trendViewport.current]) {
      if (viewport) viewport.scrollLeft = viewport.scrollWidth
    }
  }, [lastDate])
  const selected =
    interaction === 'keyboard' ? (focusedDate ?? pinned) : (preview ?? focusedDate ?? pinned)
  const selectedDay = calendar.find(day => day.label === selected)
  const top = models.slice(0, 4)
  const series = [
    ...top.map((model, index) => ({ id: model.label, label: model.label, color: COLORS[index] })),
    ...(models.length > 4 ? [{ id: '\u0000other', label: text('other'), color: COLORS[4] }] : []),
  ]
  const values = (day: Day) =>
    series.map(item => ({
      ...item,
      value:
        item.id === '\u0000other'
          ? Math.max(
              0,
              day.totalTokens -
                top.reduce(
                  (sum, model) =>
                    sum + (stats.history?.days[day.label]?.[model.label]?.totalTokens ?? 0),
                  0
                )
            )
          : (stats.history?.days[day.label]?.[item.id]?.totalTokens ?? 0),
    }))
  const visibleValues = (day: Day) => values(day).filter(item => !hidden.includes(item.id))
  const maximum = Math.max(
    1,
    ...daily.map(day => visibleValues(day).reduce((sum, item) => sum + item.value, 0))
  )
  const heatMaximum = Math.max(1, ...daily.map(day => day.totalTokens))
  const detail = selectedDay?.row
  const inspect = (date: string) => setPinned(current => (current === date ? null : date))
  const accessible = (date: string, row?: Day) =>
    `${date} · ${row ? `${number(row.totalTokens)} ${text('totalTokens')} · ${number(row.requests)} ${text('requests')}` : text('unavailableDay')}`
  const focusClass =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background'
  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || (!preview && !focusedDate && !pinned)) return
    event.stopPropagation()
    setPinned(null)
    setPreview(null)
    setFocusedDate(null)
  }
  return (
    <section className="mb-8 space-y-6" onKeyDown={onEscape} data-testid="usage-charts">
      <div className="rounded-2xl bg-surface/40 p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">{text('heatmap')}</h2>
          <span className="text-xs text-text-secondary">{text('calendarWindow')}</span>
        </div>
        <div
          className="-mx-1 overflow-x-auto pb-2"
          data-testid="usage-heatmap-viewport"
          ref={heatmapViewport}
          onKeyDown={event => {
            setInteraction('keyboard')
            moveDate(event, 7)
          }}
        >
          {/* Reserve space inside the scrollable content for the outer focus ring. */}
          <div className="w-max min-w-full p-1">
            <div
              className="mb-2 flex min-w-max justify-between text-xs text-text-secondary"
              aria-hidden="true"
            >
              <span>{calendar[0]?.label}</span>
              <span>{calendar.at(-1)?.label} · UTC</span>
            </div>
            <div
              className="grid auto-cols-[minmax(1.5rem,1fr)] grid-flow-col grid-rows-7 gap-1 max-md:auto-cols-[minmax(2.75rem,1fr)]"
              data-testid="usage-heatmap"
            >
              {calendar.map(day => {
                const level = day.row?.totalTokens
                  ? Math.min(4, 1 + Math.floor((day.row.totalTokens / heatMaximum) * 4))
                  : 0
                return (
                  <button
                    key={day.label}
                    type="button"
                    data-date={day.label}
                    aria-label={accessible(day.label, day.row)}
                    aria-pressed={pinned === day.label}
                    onMouseEnter={() => {
                      if (interaction === 'pointer') setPreview(day.label)
                    }}
                    onMouseMove={() => {
                      setInteraction('pointer')
                      setPreview(day.label)
                    }}
                    onMouseLeave={() => setPreview(null)}
                    onFocus={() => {
                      setInteraction('keyboard')
                      setFocusedDate(day.label)
                      setPreview(day.label)
                    }}
                    onBlur={() => {
                      setFocusedDate(current => (current === day.label ? null : current))
                      setPreview(null)
                    }}
                    onClick={() => inspect(day.label)}
                    className={`h-6 min-w-6 rounded-md transition-colors max-md:h-11 max-md:min-w-11 ${focusClass} ${HEAT[level]} ${!day.row ? 'border border-dashed border-text-muted/20' : ''} ${selected === day.label ? 'ring-2 ring-focus' : 'hover:ring-2 hover:ring-text-muted/40'}`}
                  />
                )
              })}
            </div>
          </div>
        </div>
        <p
          className="mt-3 min-h-5 text-sm tabular-nums text-text-secondary"
          data-testid="usage-calendar-preview"
        >
          {selected ? accessible(selected, detail) : text('inspectHelp')}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-text-secondary">
          <span>{text('unavailableLegend')}</span>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {text('heatmapLess')}
            {HEAT.map(color => (
              <span key={color} className={`h-3 w-3 rounded-sm ${color}`} />
            ))}
            {text('heatmapMore')}
          </div>
        </div>
      </div>
      <div className="rounded-2xl bg-surface/40 p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium">{text('dailyTrend')}</h2>
          <span className="text-xs text-text-secondary">{text('chartHelp')}</span>
        </div>
        <div className="flex gap-2">
          <div
            className="flex h-44 w-8 shrink-0 flex-col justify-between text-right text-xs tabular-nums text-text-secondary"
            aria-hidden="true"
          >
            {[maximum, maximum / 2, 0].map((value, index) => (
              <span key={index}>
                {new Intl.NumberFormat(locale, {
                  notation: 'compact',
                  maximumFractionDigits: 1,
                }).format(value)}
              </span>
            ))}
          </div>
          <div
            className="min-w-0 flex-1 overflow-x-auto pb-2"
            data-testid="usage-trend"
            ref={trendViewport}
          >
            <div
              className="flex min-w-max"
              onKeyDown={event => {
                setInteraction('keyboard')
                moveDate(event, 1)
              }}
            >
              {daily.map((day, index) => (
                <div key={day.label} className="min-w-6 flex-1 max-md:min-w-11">
                  <button
                    type="button"
                    data-date={day.label}
                    aria-label={accessible(
                      day.label,
                      calendar.find(item => item.label === day.label)?.row
                    )}
                    aria-pressed={pinned === day.label}
                    onMouseEnter={() => {
                      if (interaction === 'pointer') setPreview(day.label)
                    }}
                    onMouseMove={() => {
                      setInteraction('pointer')
                      setPreview(day.label)
                    }}
                    onMouseLeave={() => setPreview(null)}
                    onFocus={() => {
                      setInteraction('keyboard')
                      setFocusedDate(day.label)
                      setPreview(day.label)
                    }}
                    onBlur={() => {
                      setFocusedDate(current => (current === day.label ? null : current))
                      setPreview(null)
                    }}
                    onClick={() => inspect(day.label)}
                    className={`flex h-44 w-full flex-col-reverse overflow-hidden rounded-t-md border-b border-border transition-colors ${focusClass} ${selected === day.label ? 'bg-text-muted/15 ring-1 ring-focus' : 'bg-text-muted/5 hover:bg-text-muted/10'}`}
                  >
                    {visibleValues(day).map(item => (
                      <span
                        key={item.id}
                        data-series={item.id}
                        className={`block w-full shrink-0 ${item.color}`}
                        style={{ height: `${(item.value / maximum) * 100}%` }}
                      />
                    ))}
                  </button>
                  <div
                    className="mt-2 h-4 whitespace-nowrap text-center text-xs text-text-secondary"
                    aria-hidden="true"
                  >
                    {index % Math.max(1, Math.ceil(daily.length / 6)) === 0
                      ? day.label.slice(5)
                      : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          className="mt-4 flex flex-wrap gap-2"
          data-testid="usage-trend-legend"
          role="group"
          aria-label={text('filterModels')}
        >
          {series.map(item => (
            <button
              type="button"
              key={item.id}
              aria-pressed={!hidden.includes(item.id)}
              onClick={() =>
                setHidden(current =>
                  current.includes(item.id)
                    ? current.filter(id => id !== item.id)
                    : [...current, item.id]
                )
              }
              className={`flex min-h-7 items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors hover:bg-text-muted/10 max-md:min-h-11 ${focusClass} ${hidden.includes(item.id) ? 'text-text-muted line-through' : 'text-text-primary'}`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} aria-hidden="true" />
              {item.label}
            </button>
          ))}
          {hidden.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setHidden([])}>
              {text('showAll')}
            </Button>
          )}
        </div>
      </div>
      <div
        className="min-h-36 rounded-xl border border-border/60 p-4"
        data-testid="usage-day-detail"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">
            {selected ? `${selected} · UTC` : text('inspectDay')}
          </h3>
          {pinned && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPinned(null)
                setPreview(null)
                setFocusedDate(null)
              }}
            >
              {text('clearSelection')}
            </Button>
          )}
        </div>
        {!selected ? (
          <p className="mt-3 text-sm text-text-secondary">{text('inspectHelp')}</p>
        ) : !detail ? (
          <p className="mt-3 text-sm text-text-secondary">{text('unavailableDay')}</p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(['totalTokens', 'requests', 'inputTokens', 'outputTokens'] as const).map(key => (
                <div key={key}>
                  <dt className="text-xs text-text-secondary">{text(key)}</dt>
                  <dd className="mt-1 text-base font-medium tabular-nums">{number(detail[key])}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
              {Object.entries(stats.history?.days[selected] ?? {}).map(([model, usage]) => (
                <span key={model}>
                  {model} · {number(usage.totalTokens)}
                </span>
              ))}
              {!detail.requests && <span>{text('zeroDay')}</span>}
              {(detail.unreportedRequests > 0 || detail.estimatedTotalRequests > 0) && (
                <span>
                  {t('usageHistory.partial', {
                    missing: detail.unreportedRequests,
                    estimated: detail.estimatedTotalRequests,
                  })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
