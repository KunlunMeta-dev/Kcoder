import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useMigrationSourceTransfer } from './useMigrationSourceTransfer'
import type { GatewayServer } from './gatewayRpc'

const target: GatewayServer = { id: 'target-host', label: 'Target', description: '', runtime: 'kcoder', transport: 'local' }
const source = { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source' as const, targetId: 'source-host' }
const selections = [{ kind: 'configuration' as const, sourceId: 'original-ref' }]
const response = (value: unknown) => new Response(JSON.stringify(value))
const unknown = (requestId: string) => ({ requestId, coordinatorState: 'unknown', observation: 'unobserved', result: null, progress: null, errorCode: null })
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())
it('saves recovery before run, prevents duplicate start and closes only the owned target', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const input = JSON.parse(String(init?.body))
    if (String(url).endsWith('/open')) return response({ status: 'ready', launching: false, ownedChildren: 1 })
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    expect(localStorage.length).toBe(1)
    return response(unknown(input.requestId))
  })
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useMigrationSourceTransfer(target, () => true))
  await act(() => result.current.start(source, selections))
  const id = result.current.requestId
  expect(id).toBeTruthy()
  await act(() => result.current.start(source, selections))
  expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/run'))).toHaveLength(1)
  unmount()
  const closing = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))
  expect(closing).toMatchObject({ purpose: 'target', targetId: target.id })
  expect(closing.sessionId).not.toBe(source.sessionId)
})
it('retry after a lost run acknowledgement performs only a read of the original operation', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) return response({ status: 'ready', launching: false, ownedChildren: 1 })
    if (String(url).endsWith('/run')) throw new Error('lost reply')
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    return response(unknown(JSON.parse(String(init?.body)).requestId))
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useMigrationSourceTransfer(target, () => true))
  await act(() => result.current.start(source, selections))
  expect(result.current.error).toBe('source_transfer_outcome_unknown')
  const id = result.current.requestId
  await act(() => result.current.retry())
  expect(result.current.result?.requestId).toBe(id)
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
    '/api/migration/source-session/open', '/api/migration/source-transfer/run', '/api/migration/source-transfer/read',
  ])
})
it('retry after an uncertain connection keeps the original target and attempt identities', async () => {
  let first = true
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/open')) {
      if (first) { first = false; throw new Error('open reply lost') }
      return response({ status: 'ready', launching: false, ownedChildren: 1 })
    }
    if (String(url).endsWith('/close')) return response({ status: 'released' })
    return response(unknown(JSON.parse(String(init?.body)).requestId))
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(() => useMigrationSourceTransfer(target, () => true))
  await act(() => result.current.start(source, selections))
  const id = result.current.requestId
  expect(localStorage.length).toBe(0)
  await act(() => result.current.retry())
  expect(fetcher.mock.calls[0][1]?.body).toEqual(fetcher.mock.calls[1][1]?.body)
  expect(result.current.result?.requestId).toBe(id)
})
it('a target open that finishes after unmount cannot submit a transfer', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/open')
    ? new Promise(resolve => { finish = resolve }) : response({ status: 'released' }))
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useMigrationSourceTransfer(target, () => true))
  let pending!: Promise<void>
  act(() => { pending = result.current.start(source, selections) })
  unmount()
  await act(async () => { finish(response({ status: 'ready', launching: false, ownedChildren: 1 })); await pending })
  expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/run'))).toBe(false)
  expect(localStorage.length).toBe(0)
})
