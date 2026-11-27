import { CircleCheck, CircleHelp, CircleX, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProviderProbeResult } from '@/kcoder/providerSettings'

export function ProviderConnectionStatus({ check, testing }: {
  check?: ProviderProbeResult
  testing: boolean
}) {
  const { t } = useTranslation('common')
  const state = testing ? 'checking' : check ? check.success ? 'connected' : 'failed' : 'untested'
  const status = t(`providerSettings.connection_${state}`)
  const details = [status]
  if (check?.checkedAtMs && !testing) {
    details.push(t('providerSettings.connection_checked_at', {
      time: new Date(check.checkedAtMs).toLocaleString(),
    }))
    if (typeof check.latencyMs === 'number') details.push(`${check.latencyMs} ms`)
    if (!check.success) details.push(t(`providerSettings.probe_${check.errorType ?? 'response'}`))
  }
  const Icon = testing ? LoaderCircle : check ? check.success ? CircleCheck : CircleX : CircleHelp
  return <span role="img" aria-label={details.join(' · ')} title={details.join('\n')}
    data-testid="provider-connection-status" data-status={state}
    className={`inline-flex shrink-0 ${testing || !check ? 'text-text-muted' : check.success ? 'text-success' : 'text-destructive'}`}>
    <Icon aria-hidden="true" className={`size-3.5 ${testing ? 'animate-spin' : ''}`} />
  </span>
}
