import { expect, test, vi } from 'vitest'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { localGatewayServer } from '../../gatewayRuntime.test-support'
import { readThreadInventory } from './threadInventory'

const workspace = { server: localGatewayServer(), workspacePath: '/workspace' }
function fixture(pages: Array<Record<string, unknown>>, negotiated = true) {
  const request = vi.fn(async () => pages.shift())
  const client = { request, supportsExperimental: () => negotiated } as unknown as GatewayClient
  return { request, read: (current = () => true) => readThreadInventory({ tasks: new Map(), archivedTasks: new Map() }, workspace, client, current) }
}
const complete = { completeness: 'complete', issueCount: 0 }

test('one inventory owns complete pagination and carries Native rows without another read', async () => {
  const first = { id: 'first' }, second = { id: 'second' }
  const f = fixture([{ ...complete, threads: [first], nextCursor: 'next' }, { ...complete, threads: [second] }])
  await expect(f.read()).resolves.toMatchObject({ threads: [first, second], complete: true, issueCount: 0 })
  expect(f.request.mock.calls).toHaveLength(2)
  expect(f.request).toHaveBeenLastCalledWith('thread/list', { limit: 100, allowPartial: true, cursor: 'next' })
})

test.each([
  [{ ...complete, threads: null }],
  [{ threads: [], completeness: 'complete', issueCount: 1 }],
  [{ threads: [], completeness: 'partial', issueCount: -1 }],
  [{ threads: [], completeness: 'partial', issueCount: 1, nextCursor: 'next' }, { ...complete, threads: [] }],
  [{ ...complete, threads: [], nextCursor: 'next' }, { ...complete, threads: [], nextCursor: 'next' }],
].map(pages => ({ pages })))('invalid or changing inventories fail instead of becoming a complete snapshot ($pages)', async ({ pages }) => {
  await expect(fixture(pages).read()).rejects.toThrow()
})

test('legacy partial metadata stays partial even when a later page omits it', async () => {
  const f = fixture([{ threads: [], completeness: 'partial', nextCursor: 'next' }, { threads: [] }], false)
  await expect(f.read()).resolves.toMatchObject({ complete: false })
})

test('a retired inventory stops before requesting another Native page', async () => {
  const f = fixture([{ ...complete, threads: [], nextCursor: 'next' }])
  await expect(f.read(() => false)).resolves.toBeNull()
  expect(f.request).toHaveBeenCalledOnce()
})

test('endless empty continuation pages retain the same bounded scan budget', async () => {
  const f = fixture(Array.from({ length: 101 }, (_, index) => ({ ...complete, threads: [], nextCursor: `page-${index}` })))
  await expect(f.read()).rejects.toThrow('THREAD_LIST_INVENTORY_LIMIT_EXCEEDED')
  expect(f.request).toHaveBeenCalledTimes(100)
})

test('an oversized final page cannot bypass the bounded thread count', async () => {
  const f = fixture([{ ...complete, threads: Array.from({ length: 10_001 }, (_, id) => ({ id: String(id) })) }])
  await expect(f.read()).rejects.toThrow('THREAD_LIST_INVENTORY_LIMIT_EXCEEDED')
  expect(f.request).toHaveBeenCalledOnce()
})
