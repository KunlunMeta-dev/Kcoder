import { expect, it } from 'vitest'
import { HistoryFamilyCache, validHistorySources } from '../../../shared/migrationHistoryFamilies'
import type { HistorySourceSummary, MigrationHistorySourcesResult } from '../../../shared/generated/contracts'
const item = (id: string, patch: Partial<HistorySourceSummary> = {}): HistorySourceSummary => ({ source: 'codex', sourceHandle: id,
  sourceSessionId: id, sourceArtifactId: id, parentSessionId: null, agentId: null, title: `Original ${id}`, project: '/source',
  bytes: 3, modifiedAtMs: null, archived: false, compressed: false, previewIncomplete: false, importIssues: [], ...patch })
const page = (items: HistorySourceSummary[], patch: Partial<MigrationHistorySourcesResult> = {}): MigrationHistorySourcesResult => ({ catalogId: 'owned',
  discoveryComplete: true, items, totalItems: items.length, problems: [], ...patch })
const first = () => page(Array.from({ length: 10 }, (_, n) => item(n ? `sibling-${n}` : 'root', n ? { parentSessionId: 'root' } : {})), { totalItems: 12, nextCursor: 'next' })

it('keeps a cross-page grandchild with its observed original root across different cwd and never adds parent rows or selections', () => {
  const cache = new HistoryFamilyCache('source-child-a'); cache.observe('source-child-a', first())
  const child = item('child', { parentSessionId: 'sibling-9', project: '/child-worktree' }), grandchild = item('grandchild', { parentSessionId: 'child' })
  const groups = cache.observe('source-child-a', page([child, grandchild], { totalItems: 12 }))
  expect(groups).toHaveLength(1); expect(groups[0]).toMatchObject({ sessionId: 'root', title: 'Original root', parentOnPage: false, parentObserved: true, lineageIssue: null })
  expect(groups[0].items).toEqual([child, grandchild]); expect(child.title).toBe('Original child')
})
it('rejects another source scope/catalog, mutated physical metadata and a changed total without replacing its prior cache', () => {
  const cache = new HistoryFamilyCache('source-child-a'), original = first(); cache.observe('source-child-a', original)
  for (const changed of [page([item('root')], { catalogId: 'peer', totalItems: 12 }), page([item('root', { parentSessionId: 'changed' })], { totalItems: 12 }), page([item('root')], { totalItems: 13 })]) expect(() => cache.observe('source-child-a', changed)).toThrow()
  expect(() => cache.observe('source-child-b', original)).toThrow()
  expect(cache.observe('source-child-a', original)[0].title).toBe('Original root')
})
it('labels observed missing parents, conflicting variants and cycles without inventing a root or changing original physical titles', () => {
  for (const [rows, issue] of [
    [[item('orphan', { parentSessionId: 'missing' })], 'missing_parent'],
    [[item('a', { parentSessionId: 'b' }), item('b', { parentSessionId: 'a' })], 'cycle'],
    [[item('variant-a', { sourceSessionId: 'same', parentSessionId: 'a' }), item('variant-b', { sourceSessionId: 'same', parentSessionId: 'b' })], 'conflict'],
  ] as const) {
    const cache = new HistoryFamilyCache('owned'), groups = cache.observe('owned', page([...rows]))
    expect(groups.every(group => group.lineageIssue === issue && group.title === null && !group.parentObserved)).toBe(true)
    expect(groups.flatMap(group => group.items).map(row => row.sourceHandle)).toEqual(rows.map(row => row.sourceHandle))
  }
})
it('keeps physical root variants and their original titles without lending one title to all variants', () => {
  const rows = [item('active', { sourceSessionId: 'root' }), item('archive', { sourceSessionId: 'root', archived: true, compressed: true }), item('child', { parentSessionId: 'root' })]
  const cache = new HistoryFamilyCache('owned'), groups = cache.observe('owned', page(rows))
  expect(groups).toHaveLength(1); expect(groups[0].title).toBeNull(); expect(groups[0].items).toEqual(rows)
})

it('does not turn Native-cleared unresolved parent metadata into a claimed root', () => {
  const rows = [item('cycle-member', { previewIncomplete: true }), item('descendant', { parentSessionId: 'cycle-member' })]
  const cache = new HistoryFamilyCache('owned'), groups = cache.observe('owned', page(rows, { discoveryComplete: false,
    problems: [{ code: 'history_discovery_family_cycle', count: 2 }] }))
  expect(groups[0]).toMatchObject({ parentObserved: false, lineageIssue: 'unobserved', title: null })
  expect(groups[0].items).toEqual(rows)
})
it('rejects oversized/duplicate/wrong-product pages and impossible first-page or cursor facts', () => {
  const original = first()
  expect(validHistorySources('codex', original)).toBe(true)
  for (const value of [{ ...original, items: [...original.items, item('eleventh')] }, { ...original, items: [item('a'), item('a')] },
    { ...original, items: original.items.map(row => ({ ...row, source: 'claude-code' })) }, { ...original, nextCursor: null },
    { ...original, totalItems: 10001 }, { ...original, items: original.items.slice(0, 9) }]) expect(validHistorySources('codex', value)).toBe(false)
  expect(validHistorySources('codex', original, { catalogId: 'owned', totalItems: 12, cursor: 'next' })).toBe(false)
})
