import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationBatchHistorySources } from './useMigrationBatchHistorySources'
import type { createMigrationApi } from './gatewayMigration'
import type { MigrationHistorySourcesResult } from '../../../shared/generated/contracts'

const api = { historyDiscover: vi.fn(), historySources: vi.fn(), historyFamilies: vi.fn() }
const typed = api as unknown as ReturnType<typeof createMigrationApi>
const page = (
  offset: number,
  count: number,
  nextCursor: string | null
): MigrationHistorySourcesResult => ({
  catalogId: 'owned-catalog',
  discoveryComplete: true,
  nextCursor,
  totalItems: 11,
  problems: [],
  items: Array.from({ length: count }, (_, index) => ({
    sourceHandle: `source-${offset + index}`,
    source: 'claude-code',
    sourceSessionId: `session-${offset + index}`,
    title: `Conversation ${offset + index}`,
    archived: false,
    compressed: false,
    bytes: 1024,
    previewIncomplete: false,
    importIssues: [],
  })),
})
beforeEach(() => {
  vi.resetAllMocks()
  api.historyDiscover.mockResolvedValue(page(0, 10, 'next'))
  api.historySources.mockImplementation(async params =>
    params.cursor === 'next' ? page(10, 1, null) : page(0, 10, 'next')
  )
})

test('explicit selections survive ten-item paging and only contain frozen catalog handles', async () => {
  const { result } = renderHook(() =>
    useMigrationBatchHistorySources(typed, 'claude-code', () => true)
  )
  expect(api.historyDiscover).not.toHaveBeenCalled()
  await act(() => result.current.discover())
  expect(result.current.catalog?.items).toHaveLength(10)
  act(() => result.current.toggle('source-0', true))
  await act(() => result.current.paginate(1))
  act(() => result.current.toggle('source-10', true))
  expect(result.current.selections).toEqual([
    { catalogId: 'owned-catalog', sourceHandle: 'source-0' },
    { catalogId: 'owned-catalog', sourceHandle: 'source-10' },
  ])
  await act(() => result.current.paginate(-1))
  expect(result.current.checked('source-0')).toBe(true)
  expect(api.historySources).toHaveBeenLastCalledWith(
    { catalogId: 'owned-catalog', cursor: undefined },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})

test('changing the source aborts an old read and cannot accept its late catalog', async () => {
  let finish!: (value: MigrationHistorySourcesResult) => void
  let signal!: AbortSignal
  api.historyDiscover.mockImplementation((_params, options) => {
    signal = options.signal
    return new Promise(resolve => {
      finish = resolve
    })
  })
  const { result, rerender } = renderHook(
    ({ kind }: { kind: 'claude-code' | 'codex' }) =>
      useMigrationBatchHistorySources(typed, kind, () => true),
    { initialProps: { kind: 'claude-code' } }
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.discover()
  })
  rerender({ kind: 'codex' })
  expect(signal.aborted).toBe(true)
  await act(async () => {
    finish(page(0, 10, 'next'))
    await pending
  })
  expect(result.current.catalog).toBeNull()
  expect(result.current.selections).toEqual([])
})

test('a foreign or overlong catalog is rejected before it can authorize any selection', async () => {
  api.historyDiscover.mockResolvedValue(page(0, 11, null))
  const { result } = renderHook(() =>
    useMigrationBatchHistorySources(typed, 'claude-code', () => true)
  )
  await act(() => result.current.discover())
  expect(result.current.error).toBe('migration_invalid_history_catalog')
  expect(result.current.catalog).toBeNull()
  act(() => result.current.toggle('source-0', true))
  expect(result.current.selections).toEqual([])
})

test('an explicit family index retains root metadata through a third page, keeps only chosen leaves and basic rediscovery clears the index', async () => {
  const familyPage = (offset: number): MigrationHistorySourcesResult => ({ ...page(offset, Math.min(10, 22 - offset), offset + 10 < 22 ? `next-${offset + 10}` : null), totalItems: 22,
    items: page(offset, Math.min(10, 22 - offset), null).items.map((item, at) => ({ ...item, source: 'codex',
      parentSessionId: offset + at === 0 ? null : offset + at < 10 ? 'session-0' : offset + at < 20 ? 'session-9' : 'session-19' })) })
  api.historyFamilies.mockResolvedValue(familyPage(0))
  api.historySources.mockImplementation(params => Promise.resolve(familyPage(Number(params.cursor?.split('-')[1] ?? 0))))
  api.historyDiscover.mockResolvedValue(familyPage(0))
  const { result } = renderHook(() => useMigrationBatchHistorySources(typed, 'codex', () => true))
  expect(api.historyFamilies).not.toHaveBeenCalled()
  await act(() => result.current.discoverFamilies()); act(() => result.current.toggle('source-9', true))
  await act(() => result.current.paginate(1)); await act(() => result.current.paginate(1)); act(() => result.current.toggle('source-21', true))
  expect(result.current.familyGroups?.[0]).toMatchObject({ sessionId: 'session-0', title: 'Conversation 0', parentObserved: true, parentOnPage: false })
  expect(result.current.selections).toHaveLength(2); expect(result.current.checked('source-0')).toBe(false)
  expect(api.historyDiscover).not.toHaveBeenCalled()
  await act(() => result.current.discover()); expect(result.current.familyMode).toBe(false); expect(result.current.familyGroups).toBeNull(); expect(result.current.selections).toEqual([])
})
