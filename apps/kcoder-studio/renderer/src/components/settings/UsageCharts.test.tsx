import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { UsageCharts } from './UsageCharts'
import { usageCalendar } from './usage-chart-calendar'
import { emptyUsage, summarizeUsage, type UsageStats } from '@/kcoder/usageHistory'
import '@/i18n'
const stats: UsageStats = {
  windowDays: 30,
  timeZone: 'UTC',
  generatedAtMs: Date.parse('2026-09-19'),
  history: {
    version: 1,
    trackedSinceMs: Date.parse('2026-09-01'),
    lastRecordedAtMs: Date.parse('2026-09-19'),
    days: {
      '2026-09-18': { alpha: { ...emptyUsage(), requests: 1, totalTokens: 100 } },
      '2026-09-19': { beta: { ...emptyUsage(), requests: 1, totalTokens: 50 } },
    },
  },
}
function setup() {
  render(<UsageCharts stats={stats} {...summarizeUsage(stats)} />)
}
test('fills calendar and distinguishes unavailable dates from zero days', () => {
  const calendar = usageCalendar(stats, summarizeUsage(stats).daily)
  expect(calendar.length).toBeGreaterThanOrEqual(176)
  expect(calendar.at(-1)?.label).toBe('2026-09-19')
  expect(calendar.find(day => day.label === '2026-08-31')?.row).toBeUndefined()
  expect(calendar.find(day => day.label === '2026-09-01')?.row?.totalTokens).toBe(0)
  setup()
  const grid = screen.getByTestId('usage-heatmap')
  expect(within(grid).getAllByRole('button')).toHaveLength(calendar.length)
  fireEvent.click(grid.querySelector('[data-date="2026-08-31"]')!)
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('不代表没有消耗')
  fireEvent.click(grid.querySelector('[data-date="2026-09-01"]')!)
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('没有已记录的请求')
})
test('preserves model colors and absolute heights and filters models', () => {
  setup()
  const chart = screen.getByTestId('usage-trend')
  const bar = chart.querySelector('[data-date="2026-09-19"]')!
  const segment = bar.querySelector('[data-series="beta"]')!
  expect(segment).toHaveClass('bg-violet-500')
  expect(segment).toHaveStyle({ height: '50%' })
  const legend = screen.getByTestId('usage-trend-legend')
  fireEvent.click(within(legend).getByRole('button', { name: 'alpha' }))
  expect(segment).toHaveStyle({ height: '100%' })
  fireEvent.click(within(legend).getByRole('button', { name: 'beta' }))
  expect(chart.querySelector('[data-series]')).toBeNull()
  fireEvent.click(within(legend).getByRole('button', { name: '显示全部' }))
  expect(bar.querySelector('[data-series="beta"]')).toHaveStyle({ height: '50%' })
})
test('supports preview, pin, keyboard navigation and escape', () => {
  setup()
  const grid = screen.getByTestId('usage-heatmap')
  const first = grid.querySelector<HTMLButtonElement>('[data-date="2026-09-18"]')!
  const next = grid.querySelector<HTMLButtonElement>('[data-date="2026-09-19"]')!
  fireEvent.click(first)
  fireEvent.mouseEnter(next)
  fireEvent.mouseMove(next)
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('beta · 50')
  fireEvent.mouseLeave(next)
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('alpha · 100')
  fireEvent.focus(first)
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(next).toHaveFocus()
  fireEvent.keyDown(next, { key: 'Escape' })
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('每日详情')
})

test('pointer leave cannot erase the current keyboard date and Escape clears its detail', () => {
  setup()
  const grid = screen.getByTestId('usage-heatmap')
  const before = grid.querySelector<HTMLButtonElement>('[data-date="2026-09-18"]')!
  const current = grid.querySelector<HTMLButtonElement>('[data-date="2026-09-19"]')!
  fireEvent.focus(current)
  fireEvent.mouseLeave(before)
  fireEvent.mouseEnter(before)
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('beta · 50')
  fireEvent.keyDown(current, { key: 'Escape' })
  expect(screen.getByTestId('usage-day-detail')).toHaveTextContent('每日详情')
})
