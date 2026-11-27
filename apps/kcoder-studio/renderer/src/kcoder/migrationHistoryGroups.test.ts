import { expect, it } from 'vitest'
import { historySourceGroups } from '../../../shared/migrationHistoryGroups'
import type { HistorySourceSummary } from '../../../shared/generated/contracts'

const item = (id: string, patch: Partial<HistorySourceSummary> = {}): HistorySourceSummary => ({
  source: 'claude-code', sourceHandle: id, sourceSessionId: 'parent', sourceArtifactId: id,
  parentSessionId: null, agentId: null, title: `Original ${id}`, project: '/source', bytes: 3,
  modifiedAtMs: null, archived: false, compressed: false, previewIncomplete: false, importIssues: [], ...patch,
})

it('keeps original per-artifact titles and puts the main row before its related agents', () => {
  const rows = [item('child', { parentSessionId: 'parent', agentId: 'a' }), item('main')]
  const before = JSON.stringify(rows), groups = historySourceGroups(rows)
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({ title: 'Original main', related: true, parentOnPage: true })
  expect(groups[0].items.map(row => row.sourceHandle)).toEqual(['main', 'child'])
  expect(groups[0].items[1].title).toBe('Original child')
  expect(JSON.stringify(rows)).toBe(before)
})

it('labels a continued or orphan family with its original parent id, never an invented main row', () => {
  const child = item('child', { parentSessionId: 'missing-parent', agentId: 'a' })
  const groups = historySourceGroups([child])
  expect(groups[0]).toMatchObject({ sessionId: 'missing-parent', title: null, parentOnPage: false, related: true })
  expect(groups[0].items).toEqual([child])
})

it('does not merge projects or source products and keeps ambiguous physical variants separate', () => {
  const rows = [item('main-a'), item('main-b'), item('other-project', { project: '/peer' }), item('codex', { source: 'codex' })]
  const groups = historySourceGroups(rows)
  expect(groups).toHaveLength(3)
  expect(groups[0].title).toBeNull()
  expect(groups.flatMap(group => group.items).map(row => row.sourceHandle)).toEqual(rows.map(row => row.sourceHandle))
})

it('retains explicit Codex fork relations without selecting a parent or changing opaque handles', () => {
  const rows = [item('fork', { source: 'codex', sourceSessionId: 'fork-id', parentSessionId: 'parent' }), item('main', { source: 'codex' })]
  expect(historySourceGroups(rows)[0].items.map(row => row.sourceHandle)).toEqual(['main', 'fork'])
  expect(rows[0].sourceSessionId).toBe('fork-id')
})

it('a unique observed parent still owns its display group when an agent or fork used another cwd', () => {
  for (const source of ['claude-code', 'codex'] as const) {
    const rows = [item('main', { source, project: '/main-workspace' }), item('child', { source, sourceSessionId: source === 'codex' ? 'fork' : 'parent', parentSessionId: 'parent', agentId: source === 'claude-code' ? 'a' : null, project: '/agent-worktree' })]
    const groups = historySourceGroups(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ parentOnPage: true, title: 'Original main' })
    expect(groups[0].items.map(row => row.sourceHandle)).toEqual(['main', 'child'])
  }
})
