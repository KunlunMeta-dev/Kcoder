import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { ReadinessObservations } from './ReadinessObservations'
import type { ConnectionView, ReadinessView } from './types'

export function ConnectionReadinessPanel({ report, connection, disabled, canAuthorize, onConfigure, onAuthorize, onResources, onCheck }: {
  report: ReadinessView; connection: ConnectionView
  disabled: boolean; canAuthorize: boolean
  onConfigure: () => void; onAuthorize: () => void; onResources: () => void; onCheck: () => void
}) {
  const { t } = useTranslation('connectivity')
  const missing = (report.capabilities ?? []).filter(value => value.state !== 'ready')
  return <section aria-label={t('readiness.title')} className="space-y-3 border-l border-border pl-3">
    <h3 className="text-sm font-medium">{t('readiness.title')}</h3>
    <p className="text-sm text-text-secondary">{t('readiness.staticBoundary')}</p>
    <ReadinessObservations report={report} connectionRevision={connection.revision} />
    {missing.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{missing.map(value => <li key={value.capabilityId}>
      {value.capabilityId}: {t(`readiness.states.${value.state === 'unavailable' ? 'missing' : value.state}`)}
    </li>)}</ul>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={disabled} variant="outline" size="sm" onClick={onConfigure}>{t('readiness.configure')}</Button>
      <Button disabled={disabled || !canAuthorize} variant="ghost" size="sm" onClick={onAuthorize}>{t('readiness.authorize')}</Button>
      <Button disabled={disabled} variant="ghost" size="sm" onClick={onResources}>{t('readiness.reviewResources')}</Button>
      <Button disabled={disabled} variant="ghost" size="sm" onClick={onCheck}>{t('readiness.recheck')}</Button>
    </div>
  </section>
}
