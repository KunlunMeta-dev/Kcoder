import type { HistorySourceSummary } from './generated/contracts'

export interface HistorySourceGroup {
  key: string
  sessionId: string
  title: string | null
  parentOnPage: boolean
  related: boolean
  items: HistorySourceSummary[]
}

/** Display claims only. Group membership never selects or authorizes another artifact. */
export function historySourceGroups(items: readonly HistorySourceSummary[]): HistorySourceGroup[] {
  const groups = new Map<string, HistorySourceGroup>()
  for (const item of items) {
    const sessionId = item.parentSessionId ?? item.sourceSessionId
    const parents = items.filter(candidate => candidate.source === item.source
      && candidate.sourceSessionId === sessionId && !candidate.agentId && !candidate.parentSessionId)
    // cwd is display provenance, not lineage. An unambiguous observed parent
    // still groups its agent/fork when that child worked in another directory.
    const key = parents.length === 1 ? JSON.stringify([item.source, 'parent', parents[0].sourceHandle])
      : JSON.stringify([item.source, item.project, sessionId])
    let group = groups.get(key)
    if (!group) {
      group = { key, sessionId, title: null, parentOnPage: false, related: false, items: [] }
      groups.set(key, group)
    }
    group.related ||= item.parentSessionId != null || item.agentId != null
    group.items.push(item)
  }
  for (const group of groups.values()) {
    const main = group.items.filter(item => item.sourceSessionId === group.sessionId && !item.agentId && !item.parentSessionId)
    // Multiple physical variants stay separate, and no variant lends its title to the others.
    group.title = main.length === 1 ? main[0].title ?? null : null
    group.parentOnPage = main.length > 0
    group.items.sort((a, b) => Number(Boolean(a.parentSessionId || a.agentId)) - Number(Boolean(b.parentSessionId || b.agentId)))
  }
  return [...groups.values()]
}
