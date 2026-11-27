import { describe, expect, it } from 'vitest'
import { adjustVirtualMessageAboveViewport } from './messageVirtualScroll'

describe('virtual message resize ownership', () => {
  it('does not shift a viewport inside one large assistant message for its later widget', () => {
    expect(adjustVirtualMessageAboveViewport({ end: 3200 }, 290, { scrollOffset: 630, scrollDirection: null })).toBe(false)
  })
  it('only compensates an entire message already above the reading viewport', () => {
    expect(adjustVirtualMessageAboveViewport({ end: 400 }, 100, { scrollOffset: 630, scrollDirection: null })).toBe(true)
    expect(adjustVirtualMessageAboveViewport({ end: 900 }, 100, { scrollOffset: 630, scrollDirection: null })).toBe(false)
  })
  it('retains the virtualizer safeguard during active backward scrolling', () => {
    expect(adjustVirtualMessageAboveViewport({ end: 400 }, -200, { scrollOffset: 630, scrollDirection: 'backward' })).toBe(false)
  })
})
