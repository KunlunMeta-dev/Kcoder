import { createContext, useContext, useState } from 'react'

/** How many recently visited workbench pages stay mounted while hidden. */
export const RETAINED_PAGE_LIMIT = 4

type Entry = { id: string; search: string; generation: number }

export const RetainedPageActive = createContext(true)

/** False while a retained page is mounted but hidden; global listeners must idle. */
export function useRetainedPageActive(): boolean {
  return useContext(RetainedPageActive)
}

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

function nextEntries(
  previous: Entry[],
  open: Record<string, boolean>,
  wasOpen: Record<string, boolean>,
  limit: number
): Entry[] {
  let entries = previous
  for (const [id, isOpen] of Object.entries(open)) {
    if (!isOpen || wasOpen[id]) continue
    const search = currentSearch()
    const existing = entries.find(entry => entry.id === id)
    // Reopening with the same deep link reuses the page; another query (for
    // example a different target) remounts it so mount-time reads stay correct.
    const entry: Entry =
      existing && existing.search === search
        ? existing
        : { id, search, generation: (existing?.generation ?? 0) + 1 }
    entries = [entry, ...entries.filter(item => item.id !== id)]
  }
  const kept: Entry[] = []
  for (const entry of entries) {
    if (open[entry.id] || kept.filter(item => !open[item.id]).length < limit) kept.push(entry)
  }
  return kept
}

/**
 * Keep recently visited pages mounted so returning to one shows its last
 * content instead of a loading state. Bounded to limit hidden pages to cap
 * background work; pages beyond it unmount as before.
 */
export function useRetainedPages(open: Record<string, boolean>, limit = RETAINED_PAGE_LIMIT) {
  const signature = JSON.stringify(open)
  const [state, setState] = useState(() => ({
    signature,
    open,
    entries: nextEntries([], open, {}, limit),
  }))
  let current = state
  if (state.signature !== signature) {
    // Derive during render (React's documented "adjust state on prop change"),
    // so a newly opened page mounts in the same commit as the route change.
    current = { signature, open, entries: nextEntries(state.entries, open, state.open, limit) }
    setState(current)
  }
  return {
    retained: (id: string) => current.entries.some(entry => entry.id === id),
    mountKey: (id: string) =>
      `${id}:${current.entries.find(entry => entry.id === id)?.generation ?? 0}`,
  }
}
