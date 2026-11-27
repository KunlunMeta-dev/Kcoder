import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ReadinessView } from './types'

export function ReadinessObservations({ report, connectionRevision }: { report: ReadinessView; connectionRevision?: string }) {
  const { t } = useTranslation('connectivity')
  const [clock, setClock] = useState(Date.now)
  const observed = report.observedAt ? Date.parse(report.observedAt) : NaN
  const expires = Number.isFinite(observed) ? observed + 60_000 : null
  useEffect(() => {

    if (expires === null) return
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expires - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [expires])
  const stale = report.state === 'stale' || expires !== null && clock >= expires
    || connectionRevision !== undefined && report.connectionRevision != null && report.connectionRevision !== connectionRevision
  const observations = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map(level => {
    const value = (Array.isArray(report.observations) ? report.observations : []).find(item => item?.level === level)
    return { level, state: stale && value?.state === 'observed' ? 'stale' : value?.state ?? 'unknown', reasonCode: value?.reasonCode }
  })
  return <div className="space-y-2" data-testid="readiness-observations">
    {stale && <p role="status" className="text-sm text-text-secondary">{t('readiness.stale')}</p>}
    <dl className="grid gap-2 text-sm sm:grid-cols-2">{observations.map(item => <div key={item.level} className="flex min-w-0 items-start justify-between gap-3">
      <dt>{t(`readiness.levels.${item.level}`)}</dt><dd className="shrink-0 text-text-secondary">{t(`readiness.states.${item.state}`)}</dd>
    </div>)}</dl>
    {expires !== null && <p className="text-xs text-text-muted">{t('readiness.observedAt', { time: new Date(observed).toLocaleString() })}</p>}
    <details className="text-xs text-text-muted"><summary>{t('readiness.details')}</summary><ul className="space-y-1 py-2">{observations.map(item => <li key={item.level}>{item.level}: {item.state}{item.reasonCode ? ` · ${item.reasonCode}` : ''}</li>)}</ul></details>
  </div>
}
