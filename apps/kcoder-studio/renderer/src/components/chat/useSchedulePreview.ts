import { useEffect, useState } from 'react'
import {
  requestAutomation,
  type AutomationProjectAddress,
  type ScheduledJob,
} from '@/kcoder/gatewayAutomationApi'

export function useSchedulePreview(
  address: AutomationProjectAddress | undefined,
  schedule: ScheduledJob['schedule'] | null,
  scope: object | undefined,
  ready: boolean
) {
  const [preview, setPreview] = useState<{
    key: string
    scope?: object
    next?: string
    error?: string
  } | null>(null)
  const deviceId = address?.deviceId
  const workspacePath = address?.workspacePath
  const serialized = JSON.stringify(schedule)
  const key = `${deviceId}\0${workspacePath}\0${serialized}`
  useEffect(() => {
    let cancelled = false
    if (!ready || !deviceId || !workspacePath || serialized === 'null') return
    const timer = window.setTimeout(() => {
      void requestAutomation<{ nextRunAt: string }>({ deviceId, workspacePath }, 'cron/preview', {
        schedule: JSON.parse(serialized),
      })
        .then(result => {
          if (!cancelled) {
            if (!Number.isFinite(Date.parse(result.nextRunAt)))
              throw new Error('Invalid schedule preview')
            setPreview({ key, scope, next: result.nextRunAt })
          }
        })
        .catch(error => {
          if (!cancelled)
            setPreview({
              key,
              scope,
              error: error instanceof Error ? error.message : String(error),
            })
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [deviceId, workspacePath, serialized, scope, ready, key])
  return ready && preview?.key === key && preview.scope === scope ? preview : null
}
