import type { VirtualItem } from '@tanstack/react-virtual'

/** A visible message's internal anchor is owned by ScrollableMessageArea. */
export function adjustVirtualMessageAboveViewport(
  item: Pick<VirtualItem, 'end'>,
  _delta: number,
  viewport: { scrollOffset: number | null; scrollDirection: 'forward' | 'backward' | null }
): boolean {
  return viewport.scrollDirection !== 'backward' && item.end <= (viewport.scrollOffset ?? 0)
}
