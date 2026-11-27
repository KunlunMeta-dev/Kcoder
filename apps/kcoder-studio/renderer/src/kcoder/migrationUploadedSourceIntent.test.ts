import { expect, it, vi } from 'vitest'
import { createMigrationSourceSessionClient } from './gatewayMigrationSourceSessions'
import { createMigrationSourceDirectoryIntent } from './migrationSourceDirectoryIntent'

const session = { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source' as const, targetId: 'owned' }
const params = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64) }
const result = { ...params, source: 'codex', remainingMs: 600000, origin: 'user_supplied' }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

it('keeps an uncertain uploaded selection on its original child and never falls back to directory discovery', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('accepted but reply lost')).mockResolvedValue(response(result))
  const client = createMigrationSourceSessionClient({ captureScope: () => 'account', fetcher })
  const intent = createMigrationSourceDirectoryIntent('codex', params)
  await expect(intent.authorize(client, session, () => true)).rejects.toMatchObject({ outcomeUnknown: true })
  expect(intent.pending()).toBe(true)
  expect(intent.matches('codex', { ...params })).toBe(true)
  expect(intent.matches('codex', '/unrelated')).toBe(false)
  await intent.authorize(client, session, () => true)
  expect(intent.pending()).toBe(false)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(JSON.parse(String(fetcher.mock.calls[1][1]?.body)))
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).query.kind).toBe('uploaded_select')
})

it('rejects an original-machine claim or a different uploaded manifest', async () => {
  for (const changed of [{ ...result, origin: 'authenticated_original_machine' }, { ...result, manifestSha256: 'b'.repeat(64) }]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(changed))
    const client = createMigrationSourceSessionClient({ captureScope: () => 'account', fetcher })
    await expect(client.selectUploaded(session, params)).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  }
})

it('validates owned memory catalogs separately from historical source pages', async () => {
  const memory = { catalogId: 'catalog', items: [{ sourceId: 'owned-note', source: 'codex', layout: 'codex_memory_files_v1',
    sourceGroup: 'memories', files: 1, bytes: 4, blockedItems: 0 }], nextCursor: null, problems: [], unobserved: [] }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(memory))
  const client = createMigrationSourceSessionClient({ captureScope: () => 'account', fetcher })
  await expect(client.query({ session, query: { kind: 'memory', params: { source: 'codex' } } })).resolves.toEqual(memory)
  await expect(client.query({ session, query: { kind: 'memory', params: { source: 'claude-code' } } })).rejects.toMatchObject({ outcomeUnknown: false })
  await expect(client.query({ session, query: { kind: 'memory_page', params: { catalogId: 'foreign' } } })).rejects.toMatchObject({ outcomeUnknown: false })
})
