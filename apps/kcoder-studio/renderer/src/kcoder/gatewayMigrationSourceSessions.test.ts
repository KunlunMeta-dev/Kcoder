import { describe, expect, it, vi } from 'vitest'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'

const input = { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source' as const, targetId: 'local' }
const ready = { status: 'ready', launching: false, ownedChildren: 1 }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
describe('source session HTTP client', () => {
  it('retains original session identity and never repeats an uncertain open', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('lost acknowledgement'))
    const client = createMigrationSourceSessionClient({ captureScope: () => 'account-a', fetcher })
    await expect(client.open(input)).rejects.toMatchObject({ code: 'source_transfer_outcome_unknown', outcomeUnknown: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input)
  })
  it('discards a response from the previous account without closing its process', async () => {
    let scope = 'account-a'
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { scope = 'account-b'; return response(ready) })
    const client = createMigrationSourceSessionClient({ captureScope: () => scope, fetcher })
    await expect(client.open(input)).rejects.toMatchObject({ code: 'source_transfer_authority_changed', outcomeUnknown: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not dispatch invalid input or a pre-aborted request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = createMigrationSourceSessionClient({ captureScope: () => 'account-a', fetcher })
    await expect(client.open({ ...input, sessionId: 'invalid' })).rejects.toMatchObject({ outcomeUnknown: false })
    const controller = new AbortController(); controller.abort()
    await expect(client.open(input, controller.signal)).rejects.toMatchObject({ outcomeUnknown: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('validates successful responses and bounds streamed response bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(ready))
      .mockResolvedValueOnce(response({ status: 'transfer_completed' }))
      .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    const client = createMigrationSourceSessionClient({ captureScope: () => 'account-a', fetcher })
    await expect(client.read(input)).resolves.toEqual(ready)
    await expect(client.read(input)).rejects.toBeInstanceOf(MigrationSourceHttpError)
    await expect(client.read(input)).rejects.toMatchObject({ outcomeUnknown: false })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
it('uses the Native binding family and rejects reordered or partial descriptions', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ bindings: [
    { sourceId: 'second', family: 'assets' }, { sourceId: 'first', family: 'configuration' },
  ] }))
  const client = createMigrationSourceSessionClient({ captureScope: () => 'account-a', fetcher })
  await expect(client.bindings(input, ['first', 'second'])).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false })
  fetcher.mockResolvedValue(response({ bindings: [{ sourceId: 'first', family: 'configuration' }] }))
  await expect(client.bindings(input, ['first', 'second'])).rejects.toMatchObject({ code: 'source_transfer_invalid_response' })
  const bindings = [{ sourceId: 'first', family: 'configuration' }, { sourceId: 'second', family: 'assets' }]
  fetcher.mockResolvedValue(response({ bindings }))
  await expect(client.bindings(input, ['first', 'second'])).resolves.toEqual({ bindings })
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ session: input,
    query: { kind: 'source_bindings', params: { sourceIds: ['first', 'second'] } } })
})
it('uses the active Relay mount and rejects a response after the mount changes', async () => {
  try {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/g/owned' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(ready))
    const client = createMigrationSourceSessionClient({ captureScope: () => 'same-account', fetcher })
    await client.open(input)
    expect(fetcher.mock.calls[0][0]).toBe('/g/owned/api/migration/source-session/open')
    fetcher.mockImplementation(async () => {
      window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { appBasePath: '/g/other' }
      return response(ready)
    })
    await expect(client.open(input)).rejects.toMatchObject({ code: 'source_transfer_authority_changed', outcomeUnknown: true })
  } finally { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ }
})


it('reads configuration layers on the same source session and rejects another source, job or page', async () => {
  const report = { target: { kind: 'source', sourceId: 'claude-source' }, status: 'not_applicable', pageIndex: 0,
    adapterRevision: null, layers: [], fields: [], totalFields: 0, nextPage: null, unobserved: [] };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(report));
  const client = createMigrationSourceSessionClient({ captureScope: () => 'account-a', fetcher });
  await expect(client.configurationLayersRead(input, { sourceId: 'claude-source' })).resolves.toEqual(report);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ session: input,
    query: { kind: 'configuration_layers_read', params: { sourceId: 'claude-source' } } });
  await expect(client.query({ session: input, query: { kind: 'configuration_layers_read', params: { sourceId: 'claude-source' } } })).resolves.toEqual(report);
  for (const invalid of [{ ...report, target: { kind: 'source', sourceId: 'peer' } },
    { ...report, target: { kind: 'job', jobId: 'target-job' } }, { ...report, pageIndex: 1 }]) {
    fetcher.mockResolvedValue(response(invalid));
    await expect(client.configurationLayersRead(input, { sourceId: 'claude-source' })).rejects.toMatchObject({ code: 'source_transfer_invalid_response', outcomeUnknown: false });
  }
  const count = fetcher.mock.calls.length;
  await expect(client.configurationLayersRead(input, { sourceId: 'claude-source', path: '/private' } as never)).rejects.toMatchObject({ code: 'source_transfer_invalid_request', outcomeUnknown: false });
  expect(fetcher).toHaveBeenCalledTimes(count);
});
