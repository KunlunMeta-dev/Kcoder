import { describe, expect, it } from 'vitest'
import { groupWikiSearchResults, wikiSearchMatchesScope } from './wikiSearchResults'

describe('Wiki search projections', () => {
  it('keeps highest-ranked source chunk and distinct pages, including same-title pages', () => {
    const hits = [
      { documentId: 'source:one:chunk-2', revisionId: 'current' },
      { documentId: 'page-one', revisionId: 'page-current' },
      { documentId: 'source:one:chunk-1', revisionId: 'current' },
      { documentId: 'source:two:chunk-1', revisionId: 'other-current' },
      { documentId: 'page-two', revisionId: 'page-current' },
      { documentId: 'page-one', revisionId: 'old-page' },
    ]
    expect(groupWikiSearchResults(hits)).toEqual([hits[0], hits[1], hits[3], hits[4]])
  })

  it('hides results from another server, library or query while a request is pending', () => {
    const response = { serverId: 'local', libraryId: 'a', query: '事务' }
    expect(wikiSearchMatchesScope(response, 'local', 'a', '事务')).toBe(true)
    expect(wikiSearchMatchesScope(response, 'remote', 'a', '事务')).toBe(false)
    expect(wikiSearchMatchesScope(response, 'local', 'b', '事务')).toBe(false)
    expect(wikiSearchMatchesScope(response, 'local', 'a', '协议')).toBe(false)
    expect(wikiSearchMatchesScope(null, 'local', 'a', '事务')).toBe(false)
  })
})
