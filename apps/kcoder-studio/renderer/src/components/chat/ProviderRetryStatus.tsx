import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProviderRetryActivity } from '@/kcoder/toolPathPreview'

export function ProviderRetryStatus({ activity }: { activity: ProviderRetryActivity }) {
  const { t } = useTranslation('chat')
  const deadline = activity.receivedAtMs + activity.retryAfterMs
  const [nowMs, setNowMs] = useState(activity.receivedAtMs)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      const now = Date.now()
      setNowMs(now)
      const remaining = deadline - now
      if (remaining > 0) timer = setTimeout(tick, Math.min(1000, remaining))
    }
    const remaining = deadline - Date.now()
    timer = setTimeout(tick, Math.max(0, Math.min(1000, remaining)))
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [activity.receivedAtMs, deadline])

  const displayNow = Math.max(nowMs, activity.receivedAtMs)
  const waiting = activity.retryAfterMs > 0 && displayNow < deadline
  const message = waiting
    ? t('provider_retry.waiting', {
        attempt: activity.attempt,
        maxRetries: activity.maxRetries,
        seconds: Math.max(1, Math.ceil((deadline - displayNow) / 1000)),
      })
    : t('provider_retry.retrying', {
        attempt: activity.attempt,
        maxRetries: activity.maxRetries,
      })

  return (
    <div
      className="inline-flex min-w-0 items-center gap-2 text-sm text-text-secondary"
      data-testid="provider-retry-status"
      data-state={waiting ? 'waiting' : 'retrying'}
      role="status"
      aria-live={waiting ? 'off' : 'polite'}
    >
      <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
