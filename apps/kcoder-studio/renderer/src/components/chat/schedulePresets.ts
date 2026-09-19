// Schedule presets for the automation panel: friendly recurring options that
// compile to the UTC cron the gateway expects, plus helpers that render any
// stored schedule as human text.

export type SchedulePresetId =
  | 'at'
  | 'hourly'
  | 'daily'
  | 'weekday'
  | 'weekly'
  | 'monthly'
  | 'interval'
  | 'cron'

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

// Convert a wall-clock time in the machine's local zone into the UTC cron
// fields the gateway stores, so presets can be written as "daily 09:00" while
// the job fires at local 09:00 wherever the target lives.
export function localTimeToUtcFields(time: LocalTime): { hour: number; minute: number } {
  const probe = new Date()
  probe.setHours(time.hour, time.minute, 0, 0)
  return { hour: probe.getUTCHours(), minute: probe.getUTCMinutes() }
}

export function utcCronFromPreset(preset: SchedulePresetId, time: LocalTime): string | null {
  const { hour, minute } = localTimeToUtcFields(time)
  const minuteField = `${minute}`
  const hourField = `${hour}`
  switch (preset) {
    case 'hourly':
      return `${minuteField} * * * *`
    case 'daily':
      return `${minuteField} ${hourField} * * *`
    case 'weekday':
      return `${minuteField} ${hourField} * * 1-5`
    case 'weekly':
      return `${minuteField} ${hourField} * * 1`
    case 'monthly':
      return `${minuteField} ${hourField} 1 * *`
    default:
      return null
  }
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

// Human description for any stored schedule, resolved in the local zone.
export function describeSchedule(
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; every_seconds: number }
    | { kind: 'cron'; expression: string },
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  if (schedule.kind === 'at') {
    return t('automations.describeAt', {
      time: new Date(schedule.at).toLocaleString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    })
  }
  if (schedule.kind === 'every') {
    const seconds = schedule.every_seconds
    if (seconds % 3600 === 0) {
      return t('automations.describeEveryHours', { count: seconds / 3600 })
    }
    if (seconds % 60 === 0) {
      return t('automations.describeEveryMinutes', { count: seconds / 60 })
    }
    return t('automations.describeEverySeconds', { count: seconds })
  }
  // cron: render the UTC fields back in local time when the pattern is a
  // simple daily/hourly form; otherwise show the raw expression.
  const fields = schedule.expression.trim().split(/\s+/)
  if (fields.length === 5) {
    const [minute, hour, dom, mon, dow] = fields
    const local = utcFieldsToLocalTime(hour, minute)
    if (local) {
      const time = formatLocalTime(local)
      if (dom === '*' && mon === '*' && dow === '1-5') {
        return t('automations.describeWeekday', { time })
      }
      if (dom === '*' && mon === '*' && dow === '*') {
        return t('automations.describeDaily', { time })
      }
      if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
        return t('automations.describeHourly', { time })
      }
    }
    return t('automations.describeCron', { expression: schedule.expression })
  }
  return t('automations.describeCron', { expression: schedule.expression })
}

function utcFieldsToLocalTime(hourField: string, minuteField: string): LocalTime | null {
  if (hourField === '*' || minuteField === '*' || hourField.includes(',') || minuteField.includes(',')) {
    return null
  }
  if (hourField.includes('/') || minuteField.includes('/') || hourField.includes('-')) return null
  const hour = Number(hourField)
  const minute = Number(minuteField)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null
  const probe = new Date()
  probe.setUTCHours(hour, minute, 0, 0)
  return { hour: probe.getHours(), minute: probe.getMinutes() }
}

export function schedulePresetFromKind(kind: ScheduleKind['kind']): SchedulePresetId {
  return kind === 'at' ? 'at' : kind === 'every' ? 'interval' : 'cron'
}

type ScheduleKind = {
  kind: 'at' | 'every' | 'cron'
}
