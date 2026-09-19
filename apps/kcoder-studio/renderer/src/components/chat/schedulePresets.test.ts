import { describe, expect, test } from 'vitest'
import {
  describeSchedule,
  formatLocalTime,
  localTimeToUtcFields,
  parseLocalTimeInput,
  utcCronFromPreset,
} from './schedulePresets'

describe('schedulePresets', () => {
  test('parses and formats local time inputs', () => {
    expect(parseLocalTimeInput('09:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseLocalTimeInput('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseLocalTimeInput('24:00')).toBeNull()
    expect(parseLocalTimeInput('abc')).toBeNull()
    expect(formatLocalTime({ hour: 9, minute: 5 })).toBe('09:05')
  })

  test('compiles local preset times into UTC cron fields', () => {
    const utc = localTimeToUtcFields({ hour: 9, minute: 0 })
    expect(utc.minute).toBe(0)
    // The cron expression must fire at local 09:00 regardless of the local-vs-UTC offset; round-trip through `Date` to verify.
    const probe = new Date()
    probe.setHours(9, 0, 0, 0)
    expect(utc.hour).toBe(probe.getUTCHours())
    expect(utcCronFromPreset('daily', { hour: 9, minute: 0 })).toBe(
      `0 ${probe.getUTCHours()} * * *`
    )
    expect(utcCronFromPreset('weekday', { hour: 9, minute: 30 })).toBe(
      `30 ${probe.getUTCHours()} * * 1-5`
    )
    expect(utcCronFromPreset('weekly', { hour: 9, minute: 0 })).toBe(
      `0 ${probe.getUTCHours()} * * 1`
    )
    expect(utcCronFromPreset('monthly', { hour: 9, minute: 0 })).toBe(
      `0 ${probe.getUTCHours()} 1 * *`
    )
    expect(utcCronFromPreset('hourly', { hour: 9, minute: 15 })).toMatch(/^\d+ \* \* \* \*$/)
    expect(utcCronFromPreset('at', { hour: 9, minute: 0 })).toBeNull()
    expect(utcCronFromPreset('cron', { hour: 9, minute: 0 })).toBeNull()
  })

  test('describes stored schedules in local time', () => {
    const t = (key: string, values?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'automations.describeAt': `at ${values?.time}`,
        'automations.describeDaily': `daily ${values?.time}`,
        'automations.describeWeekday': `weekday ${values?.time}`,
        'automations.describeHourly': `hourly ${values?.time}`,
        'automations.describeEveryHours': `every ${values?.count}h`,
        'automations.describeEveryMinutes': `every ${values?.count}m`,
        'automations.describeCron': `cron ${values?.expression}`,
      }
      return table[key] ?? key
    }
    // Construct with a fixed time zone offset: regardless of the local zone, the cron conversion must round-trip to the same local instant.
    const probe = new Date()
    probe.setHours(9, 0, 0, 0)
    const utcHour = probe.getUTCHours()
    expect(describeSchedule({ kind: 'cron', expression: `0 ${utcHour} * * *` }, t)).toBe(
      `daily 09:00`
    )
    expect(describeSchedule({ kind: 'cron', expression: `0 ${utcHour} * * 1-5` }, t)).toBe(
      `weekday 09:00`
    )
    expect(describeSchedule({ kind: 'cron', expression: '15 */2 * * *' }, t)).toBe(
      'cron 15 */2 * * *'
    )
    expect(describeSchedule({ kind: 'every', every_seconds: 7200 }, t)).toBe('every 2h')
    expect(describeSchedule({ kind: 'every', every_seconds: 300 }, t)).toBe('every 5m')
  })
})
