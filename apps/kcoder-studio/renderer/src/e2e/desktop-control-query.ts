/** Explicit open-shadow traversal for the isolated desktop verification controller. */
export function queryDesktopControls(selector: string): HTMLElement[] {
  const parts = selector.split('>>>').map(part => part.trim())
  if (parts.some(part => !part)) throw new Error('Empty desktop control selector segment')
  let roots: ParentNode[] = [document]
  let elements: HTMLElement[] = []
  for (let index = 0; index < parts.length; index++) {
    elements = roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(parts[index])))
    if (index < parts.length - 1)
      roots = elements.flatMap(element => (element.shadowRoot ? [element.shadowRoot] : []))
  }
  return elements
}

/** Image URL presence alone is not evidence that the browser decoded it. */
export function desktopControlImageMetrics(element: HTMLElement) {
  return element instanceof HTMLImageElement
    ? {
        imageComplete: element.complete,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
      }
    : {}
}
