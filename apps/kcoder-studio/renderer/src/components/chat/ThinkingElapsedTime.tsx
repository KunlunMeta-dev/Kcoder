import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function ThinkingElapsedTime({
  startedAt,
  completedAt,
  running,
}: {
  startedAt?: number
  completedAt?: number
  running: boolean
}) {
  const { t } = useTranslation('chat')
  const [now, setNow] = useState(Date.now)
  const [observedEnd, setObservedEnd] = useState<number>()
  const wasRunning = useRef(running)
  const validStart = startedAt !== undefined && Number.isFinite(startedAt) && startedAt > 0

  useEffect(() => {
    if (wasRunning.current && !running) setObservedEnd(Date.now())
    wasRunning.current = running
    if (!running || !validStart) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, validStart])

  const validEnd = completedAt !== undefined && Number.isFinite(completedAt) && completedAt > 0
  const end = running ? now : validEnd ? completedAt : observedEnd
  // Restored reasoning without a completion timestamp has no measured duration.
  if (!validStart || end === undefined) return null
  const seconds = Math.floor(Math.max(0, end - startedAt) / 1000)
  const duration = seconds < 60
    ? t('toolStatus.seconds', { count: seconds })
    : t('toolStatus.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })

  return (
    <span
      data-testid="thinking-duration"
      aria-live="off"
      className="shrink-0 tabular-nums text-xs text-text-muted"
    >
      {duration}
    </span>
  )
}
