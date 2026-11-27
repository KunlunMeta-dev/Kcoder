import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useMigrationSearch } from './useMigrationSearch'
import { notifyAccountContextChange } from './accountContextEvents'
const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./gatewayMigration', () => ({ createMigrationApi: () => ({ historySearch: read }) }))
const hit = {
  position: 9,
  record: 12,
  block: { index: 15, kind: 'text' },
  before: 'old ',
  matched: 'needle',
  after: ' text',
  bodyCursor: 'sealed-body',
}
const page = (items: unknown[], nextCursor: string | null, scannedRecords = 32) => ({
  items,
  nextCursor,
  scannedRecords,
  totalRecords: 100,
  processedBytes: 4_000_000,
  unsupportedBlocks: 0,
  excludedBlocks: 0,
})
beforeEach(() => vi.resetAllMocks())

test('a partial scan with no hits continues until the page is settled', async () => {
  read.mockResolvedValueOnce(page([], 'scan-next')).mockResolvedValueOnce(page([hit], null, 100))
  const { result } = renderHook(() =>
    useMigrationSearch('target', '/owned', 'job', 'selected', () => true)
  )
  expect(read).not.toHaveBeenCalled()
  await act(() => result.current.search('needle', false))
  expect(result.current.phase).toBe('ready')
  expect(result.current.value?.items).toEqual([hit])
  expect(read).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      jobId: 'job',
      viewId: 'selected',
      query: 'needle',
      cursor: 'scan-next',
      limit: 10,
    }),
    { signal: expect.any(AbortSignal) }
  )
})

test('result pages request at most ten and replace the prior page', async () => {
  read
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 10 }, (_, i) => ({ ...hit, position: i })),
        'second'
      )
    )
    .mockResolvedValueOnce(page([hit], null, 100))
  const { result } = renderHook(() =>
    useMigrationSearch('target', undefined, 'job', undefined, () => true)
  )
  await act(() => result.current.search('needle', true))
  expect(result.current.value?.items).toHaveLength(10)
  act(() => result.current.next())
  await waitFor(() => expect(result.current.value?.items).toHaveLength(1))
  expect(read).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: 'second', limit: 10 }),
    expect.anything()
  )
})

test('pause resumes only the last confirmed cursor and ignores a late aborted scan', async () => {
  let finish!: (value: unknown) => void
  read
    .mockResolvedValueOnce(page([], 'confirmed'))
    .mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    .mockResolvedValueOnce(page([hit], null))
  const { result } = renderHook(() =>
    useMigrationSearch('target', undefined, 'job', undefined, () => true)
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.search('needle', false)
  })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  act(() => result.current.cancel())
  expect(result.current.phase).toBe('paused')
  act(() => result.current.resume())
  await waitFor(() => expect(result.current.phase).toBe('ready'))
  expect(read.mock.calls[2][0].cursor).toBe('confirmed')
  await act(async () => {
    finish(page([{ ...hit, matched: 'stale' }], null))
    await pending
  })
  expect(result.current.value?.items[0].matched).toBe('needle')
})

test('changing target or account clears source text and does not accept the old response', async () => {
  read.mockResolvedValue(page([hit], null))
  const { result, rerender } = renderHook(
    ({ target }) => useMigrationSearch(target, '/owned', 'job', undefined, () => true),
    { initialProps: { target: 'old' } }
  )
  await act(() => result.current.search('needle', false))
  expect(result.current.value?.items).toHaveLength(1)
  rerender({ target: 'new' })
  expect(result.current.value).toBeNull()
  await act(() => result.current.search('needle', false))
  act(() => notifyAccountContextChange('new'))
  expect(result.current.value).toBeNull()
})
