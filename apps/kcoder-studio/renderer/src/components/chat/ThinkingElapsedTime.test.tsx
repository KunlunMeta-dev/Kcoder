import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { ThinkingElapsedTime } from './ThinkingElapsedTime'

const start = 1_800_000_000_000
const seconds = (count: number) => i18n.t('toolStatus.seconds', { ns: 'chat', count })
afterEach(() => vi.useRealTimers())

test('ticks during reasoning and freezes at its recorded completion before later tools run', () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  expect(seconds(0)).not.toBe('toolStatus.seconds')
  const { rerender } = render(<ThinkingElapsedTime startedAt={start} running />)
  expect(screen.getByTestId('thinking-duration')).toHaveTextContent(seconds(0))
  act(() => { vi.advanceTimersByTime(11_000) })
  expect(screen.getByTestId('thinking-duration')).toHaveTextContent(seconds(11))
  rerender(<ThinkingElapsedTime startedAt={start} completedAt={start + 10_000} running={false} />)
  act(() => { vi.advanceTimersByTime(60_000) })
  expect(screen.getByTestId('thinking-duration')).toHaveTextContent(seconds(10))
  expect(vi.getTimerCount()).toBe(0)
})

test('restored reasoning uses saved timestamps rather than time since opening history', () => {
  vi.useFakeTimers()
  vi.setSystemTime(start + 3_600_000)
  render(<ThinkingElapsedTime startedAt={start} completedAt={start + 11_000} running={false} />)
  expect(screen.getByTestId('thinking-duration')).toHaveTextContent(seconds(11))
  expect(vi.getTimerCount()).toBe(0)
})

test('does not invent a duration for historical reasoning without a completion record', () => {
  render(<ThinkingElapsedTime startedAt={start} running={false} />)
  expect(screen.queryByTestId('thinking-duration')).not.toBeInTheDocument()
})

test('records an observed live stop when an older stream lacks a completion timestamp', () => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const { rerender, unmount } = render(<ThinkingElapsedTime startedAt={start} running />)
  act(() => { vi.advanceTimersByTime(2500) })
  rerender(<ThinkingElapsedTime startedAt={start} running={false} />)
  act(() => { vi.advanceTimersByTime(5000) })
  expect(screen.getByTestId('thinking-duration')).toHaveTextContent(seconds(2))
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
