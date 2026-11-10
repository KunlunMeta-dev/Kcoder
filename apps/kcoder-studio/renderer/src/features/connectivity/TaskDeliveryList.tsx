import { CircleCheck, CircleHelp, CircleX, Clock } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ChannelDelivery } from '@/kcoder/channels'

const ICONS: Record<ChannelDelivery['deliveryState'], { icon: typeof Clock; tone: string }> = {
  pending: { icon: Clock, tone: 'text-text-secondary' },
  sending: { icon: Clock, tone: 'text-text-secondary' },
  accepted: { icon: CircleCheck, tone: 'text-success' },
  failed: { icon: CircleX, tone: 'text-destructive' },
  unknown: { icon: CircleHelp, tone: 'text-warning' },
}

/**
 * Read-only reply delivery states for one bound task. An unconfirmed delivery may
 * already have reached the chat, so this list deliberately offers no resend.
 */
export function TaskDeliveryList({ deliveries }: { deliveries: ChannelDelivery[] }) {
  const { t } = useTranslation('connectivity')
  return (
    <section className="space-y-2" data-testid="task-delivery-list" aria-labelledby="task-delivery-title">
      <h3 id="task-delivery-title" className="font-medium">
        {t('chatTasks.deliveries.title')}
      </h3>
      {deliveries.length === 0 ? (
        <p className="text-sm text-text-secondary" data-testid="task-delivery-empty">
          {t('chatTasks.deliveries.empty')}
        </p>
      ) : (
        <ul className="space-y-2">
          {deliveries.map(row => {
            const { icon: Icon, tone } = ICONS[row.deliveryState]
            const showCode = row.code && ['failed', 'unknown'].includes(row.deliveryState)
            return (
              <li
                key={row.deliveryId}
                className="min-w-0 space-y-1 rounded-md border border-border p-3 text-sm"
                data-testid="task-delivery-item"
                data-delivery-state={row.deliveryState}
              >
                <span className="flex items-center gap-2">
                  <Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />
                  <span className="font-medium">
                    {t(`chatTasks.deliveries.state.${row.deliveryState}`)}
                  </span>
                </span>
                <span className="block text-text-secondary">
                  {t(`chatTasks.deliveries.phase.${row.phase}`)}
                  {row.createdAtMs !== undefined && <> · <time dateTime={new Date(row.createdAtMs).toISOString()}>
                    {new Date(row.createdAtMs).toLocaleString()}
                  </time></>}
                </span>
                {row.deliveryState === 'unknown' && (
                  <p data-testid="task-delivery-unconfirmed-hint">
                    {t('chatTasks.deliveries.unknownHint')}
                  </p>
                )}
                {row.deliveryState === 'failed' && row.code === 'WEIXIN_SEND_PREPARATION_FAILED' && (
                  <p>{t('chatTasks.deliveries.weixinPrepareFailedHint')}</p>
                )}
                {showCode && (
                  <p className="break-all text-text-muted" data-testid="task-delivery-code">
                    {t('chatTasks.deliveries.code')}: <code>{row.code}</code>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
