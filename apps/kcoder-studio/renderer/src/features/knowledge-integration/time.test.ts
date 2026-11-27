import { describe, expect, it } from 'vitest'
import { formatAutomationTimestamp } from './time'
describe('schedule-zone display', () => {
  it('shows the saved Asia/Shanghai schedule at 09:00 on a UTC browser host', () => {
    const at = Date.parse('2026-10-25T01:00:00Z')
    expect(formatAutomationTimestamp(at, 'zh-CN', 'Asia/Shanghai')).toContain('09:00')
    expect(formatAutomationTimestamp(at, 'en', 'UTC')).toContain('01:00')
  })
  it('uses real DST offsets and does not invent a date for invalid zones', () => {
    expect(
      formatAutomationTimestamp(Date.parse('2026-10-25T00:30:00Z'), 'en', 'Europe/Berlin')
    ).toContain('02:30')
    expect(
      formatAutomationTimestamp(Date.parse('2026-10-25T01:30:00Z'), 'en', 'Europe/Berlin')
    ).toContain('02:30')
    expect(formatAutomationTimestamp(1000, 'zh-CN', 'Invented/Timezone')).toBeUndefined()
    expect(formatAutomationTimestamp(Number.NaN, 'en', 'UTC')).toBeUndefined()
  })
})
