import { expect, it, vi } from 'vitest'
import { createMigrationSourceSessionClient } from './gatewayMigrationSourceSessions'
const session = { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source' as const, targetId: 'source' }
const source = { sourceId: 'owned-source', kind: 'codex', displayName: 'Codex', formatRevision: 'passive-definition/v1', availableCategories: ['agent'], scope: 'user-agents' }
const value = { catalogId: 'owned-catalog', sources: [source], problems: [], totalSources: 1, nextPage: null }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
it('uses only source-only typed definition requests and rejects foreign or oversized result catalogs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
  const client = createMigrationSourceSessionClient({ captureScope: () => 'owned-account', fetcher })
  await expect(client.definitions(session, { sources: ['codex'] })).resolves.toEqual(value)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ session, query: { kind: 'definitions', params: { sources: ['codex'] } } })
  for (const changed of [{ ...value, catalogId: 'foreign' }, { ...value, sources: [source, source] }, { ...value, sources: [{ ...source, availableCategories: ['instructions'] }] }]) {
    fetcher.mockResolvedValueOnce(response(changed))
    await expect(client.definitions(session, { sources: ['codex'], catalogId: 'owned-catalog' })).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
  }
  const before = fetcher.mock.calls.length
  await expect(client.definitions(session, { sources: ['codex'], jobId: 'unauthorized-target-job' } as never)).rejects.toMatchObject({ outcomeUnknown: false })
  expect(fetcher).toHaveBeenCalledTimes(before)
})
