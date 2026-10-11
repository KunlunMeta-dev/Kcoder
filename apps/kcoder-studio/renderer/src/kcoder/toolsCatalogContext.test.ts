import { expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { readToolsCatalog } from './toolsCatalogContext'

vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

// Transport fixtures verify presentation budgets, independent of model behavior.
test('caps snapshots at 512 entries without shortening invocation identities', async () => {
  const tools = Array.from({ length: 513 }, (_, i) => ({
    name: `${i}${'工具😀'.repeat(150)}`,
    displayName: 'Tool',
    description: '',
    group: 'other',
    icon: 'tool',
  }))
  vi.mocked(requestLocalExecutor).mockResolvedValue({ cachePolicy: 'no-store', tools })
  const { entries, total, truncated } = await readToolsCatalog('task')
  expect(entries.size).toBe(512)
  expect(entries.has(tools[0].name)).toBe(true)
  expect(total).toBe(513)
  expect(truncated).toBe(true)
})

test('caps serialized UTF-8 bytes including Unicode and JSON escaping', async () => {
  for (const name of ['😀'.repeat(300_000), '\u0000'.repeat(200_000)]) {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      cachePolicy: 'no-store',
      tools: [{ name, displayName: 'Tool', description: '', group: 'other', icon: 'tool' }],
    })
    const snapshot = await readToolsCatalog('task')
    expect(snapshot.entries.size).toBe(0)
    expect(snapshot.total).toBe(1)
    expect(snapshot.truncated).toBe(true)
  }
  const tools = Array.from({ length: 512 }, (_, i) => ({
    name: String(i),
    displayName: 'Tool',
    description: '😀'.repeat(512),
    group: 'other',
    icon: 'tool',
  }))
  vi.mocked(requestLocalExecutor).mockResolvedValue({ cachePolicy: 'no-store', tools })
  const snapshot = await readToolsCatalog('task')
  expect(snapshot.entries.size).toBeLessThan(512)
  expect(snapshot.total).toBe(512)
  expect(snapshot.truncated).toBe(true)
})

test('preserves server truncation and normalizes untrusted totals', async () => {
  for (const total of [900, -1, NaN, '900']) {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      cachePolicy: 'no-store',
      tools: [],
      total,
      truncated: true,
    })
    expect(await readToolsCatalog('task')).toMatchObject({
      total: total === 900 ? 900 : 0,
      truncated: true,
    })
  }
  vi.mocked(requestLocalExecutor).mockResolvedValue(null)
  expect(await readToolsCatalog('task')).toMatchObject({ total: 0, truncated: false })
})
