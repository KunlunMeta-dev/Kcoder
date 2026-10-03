// Recurring presets retain calendar fields and their IANA timezone.
import type { ScheduledJob } from '@/kcoder/gatewayAutomationApi'

export type SchedulePresetId =
  'at' | 'hourly' | 'daily' | 'weekday' | 'weekly' | 'monthly' | 'interval' | 'cron'

export interface SchedulePreset {
  id: SchedulePresetId
  /** i18n key suffix under automations.presets */
  labelKey: string
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: 'at', labelKey: 'at' },
  { id: 'hourly', labelKey: 'hourly' },
  { id: 'daily', labelKey: 'daily' },
  { id: 'weekday', labelKey: 'weekday' },
  { id: 'weekly', labelKey: 'weekly' },
  { id: 'monthly', labelKey: 'monthly' },
  { id: 'interval', labelKey: 'interval' },
  { id: 'cron', labelKey: 'cron' },
]

export interface LocalTime {
  hour: number
  minute: number
}

const pad = (value: number) => String(value).padStart(2, '0')

export function zonedCronFromPreset(
  preset: SchedulePresetId,
  time: LocalTime,
  timezone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone
): Extract<ScheduledJob['schedule'], { kind: 'zoned_cron' }> | null {
  if (
    !timezone ||
    !Number.isInteger(time.hour) ||
    time.hour < 0 ||
    time.hour > 23 ||
    !Number.isInteger(time.minute) ||
    time.minute < 0 ||
    time.minute > 59
  )
    return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0)
  } catch {
    return null
  }
  const patterns: Partial<Record<SchedulePresetId, string>> = {
    hourly: `${time.minute} * * * *`,
    daily: `${time.minute} ${time.hour} * * *`,
    weekday: `${time.minute} ${time.hour} * * 1-5`,
    weekly: `${time.minute} ${time.hour} * * 1`,
    monthly: `${time.minute} ${time.hour} 1 * *`,
  }
  const expression = patterns[preset]
  return expression ? { kind: 'zoned_cron', expression, timezone } : null
}

export function parseLocalTimeInput(value: string): LocalTime | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

export function formatLocalTime(time: LocalTime): string {
  return `${pad(time.hour)}:${pad(time.minute)}`
}

// Calendar schedules describe their stored zone; one-shot instants use the local zone.
export function describeSchedule(
  schedule: ScheduledJob['schedule'],
  t: (key: string, values?: Record<string, unknown>) => string,
  locale?: string
): string {
  if (schedule.kind === 'at')
    return t('automations.describeAt', {
      time: new Date(schedule.at).toLocaleString(locale, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    })
  if (schedule.kind === 'every') {
    const seconds = schedule.every_seconds
    if (seconds % 3600 === 0) return t('automations.describeEveryHours', { count: seconds / 3600 })
    if (seconds % 60 === 0) return t('automations.describeEveryMinutes', { count: seconds / 60 })
    return t('automations.describeEverySeconds', { count: seconds })
  }
  const timezone = schedule.kind === 'zoned_cron' ? schedule.timezone : 'UTC'
  const [minute, hour, dom, mon, dow, extra] = schedule.expression.trim().split(/\s+/)
  const validMinute = /^\d+$/.test(minute ?? '') && Number(minute) <= 59
  const validHour = /^\d+$/.test(hour ?? '') && Number(hour) <= 23
  let description: string | undefined
  if (!extra && validMinute && mon === '*') {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`
    if (hour === '*' && dom === '*' && dow === '*')
      description = t('automations.describeHourly', { time: pad(Number(minute)) })
    else if (validHour && dom === '*' && dow === '*')
      description = t('automations.describeDaily', { time })
    else if (validHour && dom === '*' && dow === '1-5')
      description = t('automations.describeWeekday', { time })
    else if (validHour && dom === '*' && dow === '1')
      description = t('automations.describeWeekly', { time })
    else if (validHour && dom === '1' && dow === '*')
      description = t('automations.describeMonthly', { time })
  }
  return description
    ? t('automations.describeInZone', { schedule: description, timezone })
    : schedule.kind === 'zoned_cron'
      ? t('automations.describeZonedCron', { expression: schedule.expression, timezone })
      : t('automations.describeCron', { expression: schedule.expression })
}

export function schedulePresetFromKind(kind: ScheduledJob['schedule']['kind']): SchedulePresetId {
  return kind === 'at' ? 'at' : kind === 'every' ? 'interval' : 'cron'
}
