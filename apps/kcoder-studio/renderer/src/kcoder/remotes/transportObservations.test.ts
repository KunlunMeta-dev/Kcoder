import { afterEach, describe, expect, test, vi } from 'vitest'
import { readTransportObservations } from './transportObservations'
import { projectRemoteEntries } from './projection'
import type { RemoteCapabilityEntry } from '../../../../shared/generated/contracts'
const entry: RemoteCapabilityEntry = {
  id: 'gateway:relay-registration',
  capability: 'relay.registration',
  purpose: 'relay_transport_registration',
  targetId: 'gateway',
  transport: 'relay',
  protocol: 'kcoder_relay',
  protocolVersion: null,
  implementationVersion: null,
  state: 'observed',
  identityState: 'observed',
  businessState: 'unknown',
  nativeOwner: null,
  schemas: [
    { name: 'RelayRegisteredClientIdentity/v1', protocolVersion: '1', producerRevision: null },
  ],
  observedAt: '2026-10-25T00:00:00.000Z',
  reasonCode: 'RELAY_DURABLE_REGISTRATION_OBSERVED_NOT_ONLINE_VERIFIED',
  boundary: {
    resource: { kind: 'connection', id: 'assigned' },
    location: 'relay_registration_on_gateway',
    authorization: 'gateway_admin_metadata_only',
    allowedModels: 'not_applicable_transport',
    budget: 'not_reserved',
    tools: 'not_applicable_transport',
    confirmation: 'native_request_policy',
    inputTransfer: 'not_business_verified',
    resultTransfer: 'not_business_verified',
  },
}
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      snapshotId: 'metadata-snapshot',
      observedAt: '2026-10-25T00:00:00.000Z',
      nextCursor: null,
      total: 1,
      entries: [value],
    }),
    { status: 200 }
  )
afterEach(() => vi.unstubAllGlobals())
describe('actual finite authenticated Relay metadata consumer', () => {
  test('registered identity observation is a metadata GET and never native or business authorization', async () => {
    const fetch = vi.fn(async () => response(entry))
    vi.stubGlobal('fetch', fetch)
    expect((await readTransportObservations())[0]).toMatchObject({
      state: 'observed',
      businessState: 'unknown',
      nativeOwner: null,
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/runtime/remotes/observations',
      expect.objectContaining({ cache: 'no-store', headers: { accept: 'application/json' } })
    )
  })
  test.each([
    [403, 'denied'],
    [404, 'unknown'],
    [503, 'unavailable'],
  ] as const)(
    'HTTP %s remains %s without falling back to another target',
    async (status, expected) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status }))
      )
      expect((await readTransportObservations())[0]).toMatchObject({
        state: expected,
        nativeOwner: null,
        businessState: 'unknown',
      })
    }
  )
  test('authentication loss cannot downgrade to an unknown registration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    )
    await expect(readTransportObservations()).rejects.toThrow('REMOTE_CATALOG_OWNER_CHANGED')
  })
  test('forged native ownership and oversized metadata are rejected', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ...entry,
          nativeOwner: { accountId: 'forged', targetId: 'fake', workspaceId: null },
        })
      )
      .mockResolvedValueOnce(new Response('x'.repeat(32769)))
    vi.stubGlobal('fetch', fetch)
    expect((await readTransportObservations())[0].state).toBe('unavailable')
    expect((await readTransportObservations())[0].state).toBe('unavailable')
  })
  test('cancellation stops only the owned metadata read', async () => {
    const fetch = vi.fn(
      (_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        )
    )
    vi.stubGlobal('fetch', fetch)
    const abort = new AbortController()
    const pending = readTransportObservations(abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  test('ACP inbound is separately advertised from a real native handshake claim and never outbound permission', () => {
    const rows = projectRemoteEntries(
      { id: 'target', label: 'Target', description: '', runtime: 'kcoder', transport: 'ssh' },
      [
        {
          connectionId: 'owned',
          protocolVersion: '2026-07-27',
          implementationName: 'kcoder',
          implementationVersion: '1.0.0',
          observedAt: '2026-10-25T00:00:00.000Z',
          capabilities: { acpInboundV1: true },
          capabilityListComplete: true,
          nativeScope: null,
        },
      ]
    )
    expect(rows.find(row => row.capability === 'acp.inbound')).toMatchObject({
      protocolVersion: '1',
      state: 'advertised',
      businessState: 'unknown',
    })
    expect(rows.find(row => row.capability === 'acp.outbound')).toMatchObject({
      state: 'unavailable',
      nativeOwner: null,
    })
  })
})
