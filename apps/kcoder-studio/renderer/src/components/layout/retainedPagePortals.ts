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

const hiddenPortals = new WeakMap<HTMLElement, { display: string; priority: string }>()

function hide(node: HTMLElement) {
  if (hiddenPortals.has(node)) return
  hiddenPortals.set(node, {
    display: node.style.getPropertyValue('display'),
    priority: node.style.getPropertyPriority('display'),
  })
  node.style.setProperty('display', 'none', 'important')
  node.setAttribute('data-retained-page-portal', 'hidden')
}

function restore(node: HTMLElement) {
  const original = hiddenPortals.get(node)
  if (!original) return
  hiddenPortals.delete(node)
  if (original.display) node.style.setProperty('display', original.display, original.priority)
  else node.style.removeProperty('display')
  node.removeAttribute('data-retained-page-portal')
}

/** Hide this owner's portals until cleanup; retained pages select the outermost hidden owner. */
export function hideOwnedPortals(owner: Element): () => void {
  const hidden = new Set<HTMLElement>()
  const consider = (node: Node) => {
    if (node instanceof HTMLElement && !hidden.has(node) && isRenderedInside(node, owner)) {
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
    hidden.clear()
  }
}
