import { describe, expect, test } from 'vitest'
import {
  describeSchedule,
  formatLocalTime,
  parseLocalTimeInput,
  zonedCronFromPreset,
} from './schedulePresets'

describe('schedulePresets', () => {
  test('parses and formats local time inputs', () => {
    expect(parseLocalTimeInput('09:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseLocalTimeInput('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseLocalTimeInput('24:00')).toBeNull()
    expect(parseLocalTimeInput('abc')).toBeNull()
    expect(formatLocalTime({ hour: 9, minute: 5 })).toBe('09:05')
  })

  test('preserves local calendar fields and zone instead of freezing an offset', () => {
    const time = { hour: 0, minute: 30 }
    for (const [preset, expression] of [
      ['daily', '30 0 * * *'],
      ['weekday', '30 0 * * 1-5'],
      ['weekly', '30 0 * * 1'],
      ['monthly', '30 0 1 * *'],
      ['hourly', '30 * * * *'],
    ] as const) {
      expect(zonedCronFromPreset(preset, time, 'Asia/Tokyo')).toEqual({
        kind: 'zoned_cron',
        expression,
        timezone: 'Asia/Tokyo',
      })
    }
    expect(zonedCronFromPreset('daily', time, 'not-a-zone')).toBeNull()
    expect(zonedCronFromPreset('daily', { hour: 24, minute: 0 }, 'UTC')).toBeNull()
    expect(zonedCronFromPreset('at', time, 'UTC')).toBeNull()
  })

  test('describes recurring schedules in their stored timezone', () => {
    const t = (key: string, values?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'automations.describeAt': `at ${values?.time}`,
        'automations.describeInZone': `${values?.schedule} · ${values?.timezone}`,
        'automations.describeMonthly': `monthly ${values?.time}`,
        'automations.describeDaily': `daily ${values?.time}`,
        'automations.describeWeekday': `weekday ${values?.time}`,
        'automations.describeHourly': `hourly ${values?.time}`,
        'automations.describeEveryHours': `every ${values?.count}h`,
        'automations.describeEveryMinutes': `every ${values?.count}m`,
        'automations.describeCron': `cron ${values?.expression}`,
      }
      return table[key] ?? key
    }
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * *' }, t)).toBe('daily 09:00 · UTC')
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * 1-5' }, t)).toBe(
      'weekday 09:00 · UTC'
    )
    expect(
      describeSchedule({ kind: 'zoned_cron', expression: '30 0 1 * *', timezone: 'Asia/Tokyo' }, t)
    ).toBe('monthly 00:30 · Asia/Tokyo')
    expect(describeSchedule({ kind: 'cron', expression: '15 */2 * * *' }, t)).toBe(
      'cron 15 */2 * * *'
    )
    expect(describeSchedule({ kind: 'every', every_seconds: 7200 }, t)).toBe('every 2h')
    expect(describeSchedule({ kind: 'every', every_seconds: 300 }, t)).toBe('every 5m')
  })
})
