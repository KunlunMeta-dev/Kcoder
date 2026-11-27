export type FloatingMenuPlacement = 'above' | 'below'

export interface FloatingMenuBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export function getFloatingMenuBoundary(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-floating-menu-boundary]') ?? null
}

export function observeFloatingMenuLayout(
  element: HTMLElement | null,
  update: () => void,
  additionalElements: Array<HTMLElement | null> = []
): () => void {
  if (!element) return () => {}

  window.addEventListener('resize', update)
  window.addEventListener('scroll', update, true)
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
  observer?.observe(element)
  const boundary = getFloatingMenuBoundary(element)
  if (boundary && boundary !== element) observer?.observe(boundary)
  for (const additional of additionalElements) {
    if (additional && additional !== element && additional !== boundary) observer?.observe(additional)
  }

  return () => {
    window.removeEventListener('resize', update)
    window.removeEventListener('scroll', update, true)
    observer?.disconnect()
  }
}

export function getFloatingMenuVisibleBounds(
  element: HTMLElement | null,
  margin = 16,
  horizontalBoundary?: HTMLElement | null
): FloatingMenuBounds {
  let left = margin
  let right = window.innerWidth - margin
  let top = margin
  let bottom = window.innerHeight - margin
  let current = element?.parentElement

  while (current) {
    const style = window.getComputedStyle(current)
    const clipsHorizontally = /(auto|scroll|hidden|clip)/.test(
      `${style.overflowX}${style.overflow}`
    )
    const clipsVertically = /(auto|scroll|hidden|clip)/.test(
      `${style.overflowY}${style.overflow}`
    )
    if (clipsHorizontally || clipsVertically) {
      const rect = current.getBoundingClientRect()
      if (clipsHorizontally && rect.width > 0) {
        left = Math.max(left, rect.left + margin)
        right = Math.min(right, rect.right - margin)
      }
      if (clipsVertically && rect.height > 0) {
        top = Math.max(top, rect.top + margin)
        bottom = Math.min(bottom, rect.bottom - margin)
      }
    }
    current = current.parentElement
  }

  const boundary = horizontalBoundary === undefined
    ? getFloatingMenuBoundary(element)
    : horizontalBoundary
  if (boundary) {
    const rect = boundary.getBoundingClientRect()
    left = Math.max(left, rect.left + margin)
    right = Math.min(right, rect.right - margin)
  }

  return { left, right, top, bottom }
}

export function calculateFloatingMenuHorizontalLayout({
  anchorRect,
  containerLeft,
  visibleBounds,
  preferredWidth,
  alignment = 'start',
}: {
  anchorRect: Pick<DOMRect, 'left' | 'right' | 'width'>
  containerLeft: number
  visibleBounds: FloatingMenuBounds
  preferredWidth: number
  alignment?: 'start' | 'end' | 'center'
}): { left: number; width: number } {
  const width = Math.min(preferredWidth, Math.max(visibleBounds.right - visibleBounds.left, 0))
  const preferredLeft =
    alignment === 'end'
      ? anchorRect.right - width
      : alignment === 'center'
        ? anchorRect.left + (anchorRect.width - width) / 2
        : anchorRect.left
  const left = Math.max(
    visibleBounds.left,
    Math.min(preferredLeft, visibleBounds.right - width)
  )

  return { left: left - containerLeft, width }
}

export function calculateFloatingMenuLayout({
  triggerRect,
  visibleBounds,
  preferredPlacement,
  maxHeight,
  gap = 8,
}: {
  triggerRect: DOMRect
  visibleBounds: Pick<FloatingMenuBounds, 'top' | 'bottom'>
  preferredPlacement: FloatingMenuPlacement
  maxHeight: number
  gap?: number
}): { placement: FloatingMenuPlacement; maxHeight: number } {
  const spaceAbove = Math.max(triggerRect.top - visibleBounds.top - gap, 0)
  const spaceBelow = Math.max(visibleBounds.bottom - triggerRect.bottom - gap, 0)
  const placement =
    preferredPlacement === 'above'
      ? spaceAbove >= spaceBelow
        ? 'above'
        : 'below'
      : spaceBelow >= spaceAbove
        ? 'below'
        : 'above'
  const availableSpace = placement === 'above' ? spaceAbove : spaceBelow

  return {
    placement,
    maxHeight: Math.min(maxHeight, availableSpace),
  }
}
