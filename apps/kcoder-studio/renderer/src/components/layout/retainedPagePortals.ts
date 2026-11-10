// Portals (dialogs, menus, popovers) render into document.body, outside a
// retained page's container, so hiding the page does not hide them. This keeps
// a page's own portal nodes hidden while the page is hidden.

type Fiber = { return: Fiber | null; stateNode: unknown }

function fiberOf(node: Element): Fiber | null {
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$')) return (node as unknown as Record<string, Fiber>)[key]
  }
  return null
}

/** True when React rendered node from inside owner's subtree (through any portal). */
export function isRenderedInside(node: Element, owner: Element): boolean {
  if (owner.contains(node)) return false
  // Unknown React internals mean unknown ownership; leave the node untouched.
  for (let fiber = fiberOf(node); fiber; fiber = fiber.return) {
    if (fiber.stateNode === owner) return true
  }
  return false
}

const hiddenDisplay = new WeakMap<HTMLElement, string>()

function hide(node: Element) {
  if (!(node instanceof HTMLElement) || hiddenDisplay.has(node)) return
  hiddenDisplay.set(node, node.style.getPropertyValue('display'))
  node.style.setProperty('display', 'none', 'important')
  node.setAttribute('data-retained-page-portal', 'hidden')
}

function restore(node: HTMLElement) {
  const display = hiddenDisplay.get(node)
  if (display === undefined) return
  hiddenDisplay.delete(node)
  if (display) node.style.setProperty('display', display)
  else node.style.removeProperty('display')
  node.removeAttribute('data-retained-page-portal')
}

/** Hide owner's portal nodes now and as they appear; the returned function restores them. */
export function hideOwnedPortals(owner: Element): () => void {
  const hidden = new Set<HTMLElement>()
  const consider = (node: Node) => {
    if (node instanceof HTMLElement && isRenderedInside(node, owner)) {
      hide(node)
      hidden.add(node)
    }
  }
  Array.from(document.body.children).forEach(consider)
  const observer =
    typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(records =>
          records.forEach(record => record.addedNodes.forEach(consider))
        )
  observer?.observe(document.body, { childList: true })
  return () => {
    observer?.disconnect()
    hidden.forEach(restore)
  }
}
