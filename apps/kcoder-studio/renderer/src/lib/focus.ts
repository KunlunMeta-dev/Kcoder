/** Check page and disclosure visibility before acquiring or returning focus. */
export function isElementVisibleForFocus(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (
      parent.tagName === 'DETAILS' &&
      !parent.hasAttribute('open') &&
      !parent.querySelector(':scope > summary')?.contains(element)
    )
      return false
  }
  return true
}
