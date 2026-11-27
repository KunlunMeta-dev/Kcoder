import { useState } from 'react'
import { ScheduleTimeInput } from '../../src/components/chat/ScheduleTimeInput'
export function ScheduleTimeFixture() {
  const [value, setValue] = useState('09:30')
  return <main className="h-dvh p-6"><ScheduleTimeInput type="time" value={value} onChange={setValue} testId="schedule-time" /></main>
}
