import { ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ChannelToolRestrictions } from '@/kcoder/channels'

export function ChannelToolRestrictionsNotice({ policy }: { policy: ChannelToolRestrictions }) {
  const { t } = useTranslation('connectivity')
  const disabledTools = policy.enabled ? policy.disabledTools : []
  return <details className="group mb-4 rounded-lg border border-border text-sm" data-testid="channel-tool-restrictions">
    <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
      <span className="font-medium text-text-primary">{t('gatewayChannels.toolRestrictions')}</span>
      <span className="ml-auto text-xs">{disabledTools.length
        ? t('gatewayChannels.toolRestrictionsCount', { count: disabledTools.length })
        : t('gatewayChannels.toolRestrictionsNone')}</span>
    </summary>
    <div className="space-y-2 px-3 pb-3">
      <p className="text-text-secondary">{t('gatewayChannels.toolRestrictionsDescription')}</p>
      {disabledTools.length > 0 && <ul className="flex max-h-48 flex-wrap gap-2 overflow-y-auto overscroll-contain" aria-label={t('gatewayChannels.disabledTools')}>
        {disabledTools.map(name => <li key={name} className="max-w-full rounded-md border border-border px-2 py-1"><code className="break-all text-xs">{name}</code></li>)}
      </ul>}
      <p className="text-text-secondary">{t('gatewayChannels.toolRestrictionsApproval')}</p>
    </div>
  </details>
}
