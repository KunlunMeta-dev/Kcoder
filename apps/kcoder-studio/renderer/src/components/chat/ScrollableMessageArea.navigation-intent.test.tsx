import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { ScrollableMessageArea } from './ScrollableMessageArea'

function user(id: string, index?: number): WorkbenchMessage {
  return {
    id,
    role: 'user',
    content: id,
    createdAt: '2026-10-26T00:00:00Z',
    status: 'done',
    runtimeMessageIndex: index,
  }
}
function metrics() {
  const scroller = screen.getByTestId('chat-message-scroll-area')
  Object.defineProperties(scroller, {
    clientHeight: { value: 300, configurable: true },
    scrollHeight: { value: 1200, configurable: true },
    scrollTop: { value: 700, writable: true, configurable: true },
  })
  scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    if (top != null) scroller.scrollTop = top
  })
  scroller.getBoundingClientRect = () => ({
    top: 0,
    bottom: 300,
    height: 300,
    width: 320,
    left: 0,
    right: 320,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  const anchor = (id: string, documentTop: number) => {
    const element = [
      ...screen
        .getByTestId('chat-message-scroll-area-content')
        .querySelectorAll<HTMLElement>('[data-message-id]'),
    ].find(element => element.dataset.messageId === id)!
    element.getBoundingClientRect = () => ({
      top: documentTop - scroller.scrollTop,
      bottom: documentTop + 60 - scroller.scrollTop,
      height: 60,
      width: 320,
      left: 0,
      right: 320,
      x: 0,
      y: documentTop - scroller.scrollTop,
      toJSON: () => ({}),
    })
  }
  return { scroller, anchor }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0)
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function captureOldSettle() {
  let late: (() => void) | undefined
  const schedule = window.setTimeout.bind(window)
  vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (delay === 80 && typeof handler === 'function') late = () => handler(...args)
    return schedule(handler, delay, ...args)
  })
  return () => {
    expect(late).toBeTypeOf('function')
    late?.()
  }
}

test('a new user submission revokes queued and already dequeued old navigation timers', () => {
  const messages = [
    user('old-user'),
    {
      id: 'old-answer',
      role: 'assistant' as const,
      content: 'Old answer',
      status: 'done' as const,
      createdAt: '2026-10-26T00:00:01Z',
    },
    user('latest-user'),
  ]
  const view = render(
    <ScrollableMessageArea conversationKey="new-send-revokes-nav" messages={messages} />
  )
  act(() => vi.runOnlyPendingTimers())
  const { scroller, anchor } = metrics()
  anchor('old-user', 120)
  anchor('latest-user', 900)
  fireEvent.resize(window)
  act(() => vi.runOnlyPendingTimers())
  const fireOldTimer = captureOldSettle()
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
  expect(scroller.scrollTop).toBe(24)
  view.rerender(
    <ScrollableMessageArea
      conversationKey="new-send-revokes-nav"
      messages={[...messages, user('new-explicit-send')]}
    />
  )
  expect(scroller.scrollTop).toBe(1200)
  act(fireOldTimer)
  act(() => vi.advanceTimersByTime(2000))
  expect(scroller.scrollTop).toBe(1200)
  Object.defineProperty(scroller, 'scrollHeight', { value: 1800, configurable: true })
  view.rerender(
    <ScrollableMessageArea
      conversationKey="new-send-revokes-nav"
      messages={[
        ...messages,
        user('new-explicit-send'),
        {
          id: 'new-answer',
          role: 'assistant',
          content: 'New reply remains visible',
          status: 'streaming',
          createdAt: '2026-10-26T00:00:03Z',
        },
      ]}
    />
  )
  act(() => vi.runOnlyPendingTimers())
  expect(scroller.scrollTop).toBe(1800)
})

test('an old gap load cannot resume its navigation after a new user submission', async () => {
  let finish!: () => void
  const load = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const first = user('gap-first', 0),
    latest = user('gap-latest', 4)
  const turnNavigation = [
    {
      id: 'runtime-first',
      turnIndex: 0,
      messageIndex: 0,
      promptPreview: 'gap-first',
      responsePreview: '',
      cursor: 'first',
    },
    {
      id: 'runtime-gap',
      turnIndex: 1,
      messageIndex: 2,
      promptPreview: 'unloaded gap',
      responsePreview: '',
      cursor: 'gap',
    },
    {
      id: 'runtime-latest',
      turnIndex: 2,
      messageIndex: 4,
      promptPreview: 'gap-latest',
      responsePreview: '',
      cursor: 'latest',
    },
  ]
  const view = render(
    <ScrollableMessageArea
      conversationKey="new-send-during-gap"
      messages={[first, latest]}
      turnNavigation={turnNavigation}
      onLoadTurnNavigationItem={load}
    />
  )
  act(() => vi.runOnlyPendingTimers())
  const { scroller, anchor } = metrics()
  scroller.scrollTop = 0
  anchor('gap-first', 120)
  anchor('gap-latest', 900)
  fireEvent.resize(window)
  act(() => vi.runOnlyPendingTimers())
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[2])
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: 'runtime-gap' }))
  expect(screen.getByTestId('message-turn-navigation-loading')).toBeInTheDocument()
  const newest = user('new-send-during-old-load')
  view.rerender(
    <ScrollableMessageArea
      conversationKey="new-send-during-gap"
      messages={[first, latest, newest]}
      turnNavigation={turnNavigation}
      onLoadTurnNavigationItem={load}
    />
  )
  expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
  expect(scroller.scrollTop).toBe(1200)
  await act(async () => {
    finish()
    await Promise.resolve()
  })
  act(() => vi.advanceTimersByTime(2000))
  expect(scroller.scrollTop).toBe(1200)
})

test('the explicit bottom button overrides historical navigation instead of being suspended by it', () => {
  const view = render(
    <ScrollableMessageArea
      conversationKey="bottom-revokes-nav"
      messages={[user('bottom-first'), user('bottom-latest')]}
    />
  )
  act(() => vi.runOnlyPendingTimers())
  const { scroller, anchor } = metrics()
  anchor('bottom-first', 120)
  anchor('bottom-latest', 900)
  fireEvent.resize(window)
  act(() => vi.runOnlyPendingTimers())
  const fireOldTimer = captureOldSettle()
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
  fireEvent.scroll(scroller)
  fireEvent.click(screen.getByTestId('scroll-to-bottom-button'))
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' })
  act(fireOldTimer)
  expect(scroller.scrollTop).toBe(1200)
  view.unmount()
})

test('a newer marker cancels the old load indicator and its late completion cannot restart the old target', async () => {
  let finish!: () => void
  const load = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const first = user('marker-first', 0),
    latest = user('marker-latest', 4)
  const turnNavigation = [
    {
      id: 'runtime-marker-first',
      turnIndex: 0,
      messageIndex: 0,
      promptPreview: 'marker-first',
      responsePreview: '',
      cursor: 'first',
    },
    {
      id: 'runtime-marker-gap',
      turnIndex: 1,
      messageIndex: 2,
      promptPreview: 'unloaded marker gap',
      responsePreview: '',
      cursor: 'gap',
    },
    {
      id: 'runtime-marker-latest',
      turnIndex: 2,
      messageIndex: 4,
      promptPreview: 'marker-latest',
      responsePreview: '',
      cursor: 'latest',
    },
  ]
  render(
    <ScrollableMessageArea
      conversationKey="marker-supersedes-load"
      messages={[first, latest]}
      turnNavigation={turnNavigation}
      onLoadTurnNavigationItem={load}
    />
  )
  act(() => vi.runOnlyPendingTimers())
  const { scroller, anchor } = metrics()
  scroller.scrollTop = 0
  anchor('marker-first', 120)
  anchor('marker-latest', 900)
  fireEvent.resize(window)
  act(() => vi.runOnlyPendingTimers())
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[2])
  expect(screen.getByTestId('message-turn-navigation-loading')).toBeInTheDocument()
  fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
  expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
  expect(scroller.scrollTop).toBe(24)
  await act(async () => {
    finish()
    await Promise.resolve()
  })
  act(() => vi.advanceTimersByTime(1600))
  expect(scroller.scrollTop).toBe(24)
})
