export type WikiSearchResult = {
  documentId: string
  revisionId: string
}

/** Older targets can return several matching chunks from one source. */
export function groupWikiSearchResults<T extends WikiSearchResult>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const group = item.documentId.startsWith('source:')
      ? item.documentId.split(':').slice(0, 2).join(':')
      : item.documentId
    if (seen.has(group)) return false
    seen.add(group)
    return true
  })
}

/** A reused search component must never project another library's response. */
export function wikiSearchMatchesScope(
  response: { serverId: string; libraryId: string; query: string } | null,
  serverId: string,
  libraryId: string,
  query: string
): boolean {
  return (
    response?.serverId === serverId && response.libraryId === libraryId && response.query === query
  )
}
