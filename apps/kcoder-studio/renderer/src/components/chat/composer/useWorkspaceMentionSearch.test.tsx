import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeWorkspaceSearchResponse } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { useWorkspaceMentionSearch } from './useWorkspaceMentionSearch'

const target: WorkspaceTarget = { deviceId: 'owned-target', path: '/owned', source: 'runtime' }
const result = (name: string): RuntimeWorkspaceSearchResponse => ({ files: [
  { root: '/owned', path: name, fileName: name, matchType: 'file', score: 1 },
] })
const api = (search = vi.fn().mockResolvedValue(result('README.md'))): WorkspaceFileApi => ({
  listWorkspaceEntries: vi.fn(), readWorkspaceTextFile: vi.fn(), searchWorkspaceEntries: search,
})
const advance = async (time = 80) => act(async () => { await vi.advanceTimersByTimeAsync(time) })
beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

test('stream-like address reconstruction neither starves nor repeats a stable mention query', async () => {
  const files = api(), search = vi.mocked(files.searchWorkspaceEntries!)
  const view = renderHook(({ address }) => useWorkspaceMentionSearch('README', address, files), {
    initialProps: { address: target },
  })
  for (let frame = 0; frame < 10; frame++) {
    await advance(40)
    view.rerender({ address: { ...target } })
  }
  expect(search).toHaveBeenCalledOnce()
  expect(view.result.current.matches[0]?.fileName).toBe('README.md')
  await advance(1000)
  view.rerender({ address: { ...target, source: 'project', taskId: 'same-workspace-task' } })
  await advance()
  expect(search).toHaveBeenCalledOnce()
})

test('an unchanged address keeps its pending search and accepts its original response', async () => {
  let finish!: (value: RuntimeWorkspaceSearchResponse) => void
  const search = vi.fn(() => new Promise<RuntimeWorkspaceSearchResponse>(resolve => { finish = resolve }))
  const files = api(search), view = renderHook(({ address }) => useWorkspaceMentionSearch('README', address, files), {
    initialProps: { address: target },
  })
  await advance()
  view.rerender({ address: { ...target } })
  await advance()
  expect(search).toHaveBeenCalledOnce()
  await act(async () => { finish(result('README.md')) })
  expect(view.result.current.matches[0]?.fileName).toBe('README.md')
  expect(view.result.current.loading).toBe(false)
})

test.each(['empty', 'unsupported'] as const)('%s mention queries stay idle instead of showing endless loading', mode => {
  const files = api()
  if (mode === 'unsupported') files.searchWorkspaceEntries = undefined
  const { result: view } = renderHook(() => useWorkspaceMentionSearch(mode === 'empty' ? '  ' : 'README', target, files))
  expect(view.current).toEqual({ matches: [], loading: false, error: false })
})

test('a replacement API owner hides the prior result immediately, even with the same address and search function', async () => {
  const search = vi.fn().mockResolvedValueOnce(result('old-owner.md')).mockResolvedValue(result('current-owner.md'))
  const files = api(search), view = renderHook(({ owner }) => useWorkspaceMentionSearch('README', target, owner), {
    initialProps: { owner: files },
  })
  await advance()
  expect(view.result.current.matches[0]?.fileName).toBe('old-owner.md')
  view.rerender({ owner: { ...files } })
  expect(view.result.current.matches).toEqual([])
  expect(view.result.current.loading).toBe(true)
  await advance()
  expect(search).toHaveBeenCalledTimes(2)
  expect(view.result.current.matches[0]?.fileName).toBe('current-owner.md')
})

test('changing the real target/query reads again and ignores an old late error', async () => {
  let fail!: (error: Error) => void
  const search = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    .mockResolvedValue(result('current.md'))
  const files = api(search), view = renderHook(({ address, query }) => useWorkspaceMentionSearch(query, address, files), {
    initialProps: { address: target, query: 'README' },
  })
  await advance()
  view.rerender({ address: { ...target, deviceId: 'other-target', path: '/other' }, query: 'current' })
  await advance()
  await act(async () => { fail(new Error('old query failed')) })
  expect(search).toHaveBeenLastCalledWith('other-target', '/other', 'current', expect.any(String))
  expect(view.result.current.matches[0]?.fileName).toBe('current.md')
  expect(view.result.current.error).toBe(false)
  view.rerender({ address: target, query: '' })
  expect(view.result.current).toEqual({ matches: [], loading: false, error: false })
})
