import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RetainedPage } from '@/components/layout/retainedPages'
import type { RuntimeGoal } from '@/types/api'
import { GoalStatusBar } from './GoalStatusBar'
import { ComposerStatusRegion } from './ComposerStatusRegion'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

const goal: RuntimeGoal = {
  threadId: 'owned-goal-thread', objective: 'Owned display clock', mode: 'standard',
  status: 'active', timeUsedSeconds: 2, tokensUsed: 0, tokenBudget: null,
  createdAt: 1, updatedAt: 2, events: [],
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

test('hidden retained Goal stops rendering and catches up without resetting its snapshot anchor', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const commit = vi.fn()
  const view = (open: boolean) => <RetainedPage open={open}>
    <Profiler id="goal-clock" onRender={commit}><GoalStatusBar goal={goal} /></Profiler>
  </RetainedPage>
  const { rerender, unmount } = render(view(true))
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByText('4s')).toBeInTheDocument()
  rerender(view(false))
  const before = commit.mock.calls.length
  act(() => vi.advanceTimersByTime(30_000))
  expect(commit).toHaveBeenCalledTimes(before)
  expect(vi.getTimerCount()).toBe(0)
  rerender(view(true))
  expect(screen.getByText('34s')).toBeInTheDocument()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('browser hiding pauses ticks; a hidden terminal snapshot remains fixed after returning', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  let visible = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  const commit = vi.fn()
  const view = (value: RuntimeGoal) => <Profiler id="goal-clock" onRender={commit}>
    <GoalStatusBar goal={value} />
  </Profiler>
  const { rerender } = render(view(goal))
  visible = false
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  const before = commit.mock.calls.length
  act(() => vi.advanceTimersByTime(10_000))
  expect(commit).toHaveBeenCalledTimes(before)
  expect(vi.getTimerCount()).toBe(0)
  rerender(view({ ...goal, status: 'complete', timeUsedSeconds: 9, updatedAt: 3 }))
  expect(screen.getByText('9s')).toBeInTheDocument()
  visible = true
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  act(() => vi.advanceTimersByTime(10_000))
  expect(screen.getByText('9s')).toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})

test('a new active snapshot rebases once and a read-only view never starts a ticker', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { rerender } = render(<GoalStatusBar goal={goal} />)
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByText('7s')).toBeInTheDocument()
  const next = { ...goal, timeUsedSeconds: 20, updatedAt: 3 }
  rerender(<GoalStatusBar goal={next} />)
  expect(screen.getByText('20s')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText('21s')).toBeInTheDocument()
  rerender(<GoalStatusBar goal={next} readOnly />)
  act(() => vi.advanceTimersByTime(10_000))
  expect(screen.getByText('20s')).toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})

test('a collapsed status detail has no ticker and reopening keeps the original anchor', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const commit = vi.fn()
  render(<ComposerStatusRegion>
    <Profiler id="goal-clock" onRender={commit}><GoalStatusBar goal={goal} presentation="embedded" /></Profiler>
  </ComposerStatusRegion>)
  const trigger = screen.getByTestId('composer-status-trigger-goal')
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  act(() => vi.advanceTimersByTime(2000))
  fireEvent.click(trigger)
  act(() => vi.advanceTimersByTime(20))
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  const before = commit.mock.calls.length
  act(() => vi.advanceTimersByTime(30_000))
  expect(commit).toHaveBeenCalledTimes(before)
  expect(vi.getTimerCount()).toBe(0)
  fireEvent.click(trigger)
  expect(screen.getByText('34s')).toBeInTheDocument()
})
