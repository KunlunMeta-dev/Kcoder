import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { ScrollableMessageArea } from './ScrollableMessageArea'

vi.mock('./MessageTurnNavigation', () => ({ MessageTurnNavigation: () => null }))
vi.mock('./MessageList', () => ({
  MessageList: ({ messages }: { messages: WorkbenchMessage[] }) => (
    <div>
      {messages.map(message => (
        <div key={message.id} data-message-id={message.id}>
          <p data-scroll-anchor>{message.content}</p>
        </div>
      ))}
    </div>
  ),
}))

describe('conversation scrolling during widget layout changes', () => {
  let frames: Map<number, FrameRequestCallback>
  let resizes: Set<ResizeObserverCallback>
  let frameId: number

  beforeEach(() => {
    vi.useFakeTimers()
    frameId = 0
    frames = new Map()
    resizes = new Set()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizes.add(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const message: WorkbenchMessage = {
    id: 'widget-response',
    role: 'assistant',
    content: 'A reply containing a visualization',
    status: 'streaming',
    createdAt: '2026-10-12T00:00:00Z',
  }

  function flushFrames() {
    act(() => {
      for (let pass = 0; frames.size > 0 && pass < 10; pass++) {
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach(callback => callback(0))
      }
    })
  }

  function mount(conversationKey?: string) {
    const view = render(<ScrollableMessageArea conversationKey={conversationKey} messages={[message]} />)
    const scroller = screen.getByTestId('chat-message-scroll-area')
    let height = 600
    Object.defineProperties(scroller, {
      clientHeight: { value: 200, configurable: true },
      scrollHeight: { get: () => height, configurable: true },
      scrollTop: { value: 400, writable: true, configurable: true },
    })
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Math.min(Number(top), Math.max(0, height - 200))
    })
    scroller.scrollTo = scrollTo
    act(() => vi.runOnlyPendingTimers())
    flushFrames()
    fireEvent.scroll(scroller)
    scrollTo.mockClear()
    return {
      ...view,
      scroller,
      scrollTo,
      setHeight: (value: number) => { height = value },
      resize: () => {
        act(() => resizes.forEach(callback => callback([], {} as ResizeObserver)))
        flushFrames()
      },
    }
  }

  it('keeps a keyless pane at the user position when a widget resizes', () => {
    const area = mount()
    area.scroller.scrollTop = 100
    fireEvent.scroll(area.scroller)
    area.setHeight(900)
    area.resize()
    expect(area.scrollTo).not.toHaveBeenCalled()
    expect(area.scroller.scrollTop).toBe(100)
  })

  it.each(['wheel', 'touch', 'keyboard'])(
    'revokes an already queued follow frame as soon as upward %s input arrives', input => {
    const key = `widget-${input}-race`
    const area = mount(key)
    area.rerender(
      <ScrollableMessageArea
        conversationKey={key}
        messages={[{ ...message, content: `${message.content} and more streamed text` }]}
      />
    )
    // A callback may already be dequeued when cancellation is requested.
    const dequeued = [...frames.values()]
    if (input === 'wheel') fireEvent.wheel(area.scroller, { deltaY: -120 })
    if (input === 'touch') {
      fireEvent.touchStart(area.scroller, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(area.scroller, { touches: [{ clientY: 220 }] })
    }
    if (input === 'keyboard') fireEvent.keyDown(area.scroller, { key: 'PageUp' })
    area.scroller.scrollTop = 250
    act(() => dequeued.forEach(callback => callback(0)))
    expect(area.scrollTo).not.toHaveBeenCalled()
    expect(area.scroller.scrollTop).toBe(250)
    }
  )

  it('does not let a prior conversation follow frame move the new conversation', () => {
    const area = mount('widget-previous-owner')
    area.rerender(
      <ScrollableMessageArea
        conversationKey="widget-previous-owner"
        messages={[{ ...message, content: `${message.content} with more text` }]}
      />
    )
    const dequeued = [...frames.values()]
    area.rerender(
      <ScrollableMessageArea conversationKey="widget-new-owner" messages={[message]} />
    )
    area.scrollTo.mockClear()
    area.scroller.scrollTop = 125
    act(() => dequeued.forEach(callback => callback(0)))
    expect(area.scrollTo).not.toHaveBeenCalled()
    expect(area.scroller.scrollTop).toBe(125)
  })

  it('keeps user pause through terminal collapse and the final iframe height arriving', () => {
    const area = mount('widget-terminal-collapse')
    area.scroller.scrollTop = 100
    fireEvent.scroll(area.scroller)
    // Folding a process window temporarily makes the reading position the bottom.
    area.setHeight(300)
    area.rerender(
      <ScrollableMessageArea
        conversationKey="widget-terminal-collapse"
        messages={[{ ...message, status: 'done' }]}
      />
    )
    flushFrames()
    area.setHeight(900)
    area.resize()
    expect(area.scrollTo).not.toHaveBeenCalled()
    expect(area.scroller.scrollTop).toBe(100)
  })

  it('still follows widget growth at the bottom and resumes after a user returns there', () => {
    const area = mount('widget-bottom-follow')
    area.setHeight(900)
    area.resize()
    expect(area.scroller.scrollTop).toBe(700)
    area.scroller.scrollTop = 100
    fireEvent.scroll(area.scroller)
    area.setHeight(1000)
    area.resize()
    expect(area.scroller.scrollTop).toBe(100)
    area.scroller.scrollTop = 800
    fireEvent.scroll(area.scroller)
    area.setHeight(1100)
    area.resize()
    expect(area.scroller.scrollTop).toBe(900)
  })

  it('does not mistake browser anchoring during widget reflow for user navigation', () => {
    const area = mount('widget-automatic-layout-scroll')
    area.setHeight(900)
    area.scroller.scrollTop = 380
    fireEvent.scroll(area.scroller)
    area.resize()
    expect(area.scroller.scrollTop).toBe(700)
  })
})
