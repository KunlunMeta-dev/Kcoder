import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import { useEffect, useRef, useState } from 'react'
import { sampleRuntimeClock, type RuntimeClockSample } from '@/kcoder/runtimeClock'
import type { TurnProcessPresentation } from './turnProcessPresentation'
import i18n from '@/i18n'

export function useTurnProcessNow(presentation: TurnProcessPresentation | undefined, serverId?: string): number | undefined {
  const pageActive = useRetainedPageActive()
  const { key, startedAt, completedAt, status, canCollapse } = presentation ?? {}
  const running = !canCollapse && (status === 'running' || status === 'waiting')
  const lastSample = useRef<{ key: string; serverId: string; sample: RuntimeClockSample } | null>(null)
  const [clock, setClock] = useState<{
    key: string; serverId: string; now: number
  } | null>(null)

  useEffect(() => {
    if (!pageActive || !running || !key || !serverId || startedAt === undefined) return
    let disposed = false
    let sampling = false
    let timer: ReturnType<typeof setInterval> | undefined
    let sample = lastSample.current?.key === key && lastSample.current.serverId === serverId
      ? lastSample.current.sample : null
    if (!sample) lastSample.current = null
    const tick = () => {
      if (sample) setClock({ key, serverId,
        now: sample.serverTimeMs + performance.now() - sample.monotonicTimeMs })
    }
    const startTicker = () => {
      if (!sample) return
      tick()
      if (timer === undefined) timer = setInterval(tick, 1000)
    }
    const synchronize = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
        return
      }
      // Existing time advances immediately; network calibration never owns the ticker.
      startTicker()
      if (disposed || sampling) return
      sampling = true
      void sampleRuntimeClock(serverId).then(next => {
        if (disposed || !next || document.visibilityState !== 'visible') return
        const monotonicTimeMs = performance.now()
        const previousNow = sample
          ? sample.serverTimeMs + monotonicTimeMs - sample.monotonicTimeMs : -Infinity
        sample = {
          serverTimeMs: Math.max(previousNow, next.serverTimeMs + monotonicTimeMs - next.monotonicTimeMs),
          monotonicTimeMs,
        }
        lastSample.current = { key, serverId, sample }
        startTicker()
      }).catch(() => { /* Keep a known display clock; missing initial facts remain unavailable. */ })
        .finally(() => { sampling = false })
    }
    synchronize()
    document.addEventListener('visibilitychange', synchronize)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', synchronize)
      if (timer !== undefined) clearInterval(timer)
    }
  }, [key, serverId, running, startedAt, pageActive])

  return running
    ? clock && clock.key === key && clock.serverId === serverId
      ? clock.now : undefined
    : completedAt
}

export function useTurnProcessTime(presentation: TurnProcessPresentation | undefined, serverId?: string): string | undefined {
  const end = useTurnProcessNow(presentation, serverId)
  const startedAt = presentation?.startedAt
  return startedAt !== undefined && end !== undefined && end >= startedAt
    ? formatTurnDuration(end - startedAt) : undefined
}

export function formatTurnDuration(milliseconds: number): string {
  if (milliseconds < 1000) return i18n.t('toolStatus.lessThanSecond', { ns: 'chat' })
  let seconds = Math.floor(milliseconds / 1000)
  const parts: string[] = []
  for (const [unit, size] of [['days', 86400], ['hours', 3600], ['minutes', 60], ['seconds', 1]] as const) {
    const count = Math.floor(seconds / size)
    seconds %= size
    if (count) parts.push(i18n.t(`turn_process.duration.${unit}`, { ns: 'chat', count }))
  }
  return parts.join(i18n.t('turn_process.duration.separator', { ns: 'chat' }))
}
