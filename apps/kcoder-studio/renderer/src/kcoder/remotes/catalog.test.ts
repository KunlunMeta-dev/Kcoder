import { describe, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../gatewayRuntime.test-support'
import { notifyAccountContextChange } from '../accountContextEvents'
import type { NegotiatedRemoteFacts } from './negotiatedFacts'
import type { RemoteCapabilityCatalog } from '../../../../shared/generated/contracts'
vi.mock('./transportObservations', () => ({ readTransportObservations: vi.fn(async () => []) }))

function facts(extra: Partial<NegotiatedRemoteFacts> = {}): NegotiatedRemoteFacts {
  return {
    connectionId: 'rpc-owned-1',
    protocolVersion: '2026-07-27',
    implementationName: 'kcoder',
    implementationVersion: '1.0.0',
    observedAt: '2026-10-25T00:00:00.000Z',
    capabilities: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`cap${i}`, i !== 2])),
    capabilityListComplete: true,
    nativeScope: {
      accountId: 'native-owner',
      targetId: 'actual-native-target',
      workspaceId: 'opaque-workspace',
      identityGeneration: 'identity-original',
      targetRevision: 'target-current',
      organizationId: null,
    },
    ...extra,
  }
}
class ObservedClient extends FakeGatewayClient {
  observation: NegotiatedRemoteFacts | null = facts()
  readNegotiatedRemoteFacts() {
    return this.closed ? null : structuredClone(this.observation)
  }
}
async function fixture(connected = true) {
  const client = new ObservedClient(null)
  const createClient = vi.fn(() => client)
  const server = localGatewayServer({
    transport: 'ssh',
    host: 'private-host',
    user: 'declared-not-authenticated',
    workspacePath: '/private/workspace',
    command: 'private-command',
    profile: 'private-profile',
    security: { identity: { mode: 'kcoder-account', username: 'stored-hint' } },
  })
  const runtime = createTestGatewayRuntime('secret-fixture-token', {
    loadServers: async () => [server],
    createClient,
  })
  if (connected) await runtime.commandClient(server)
  return { runtime, client, createClient, server }
}
const read = (
  runtime: Awaited<ReturnType<typeof fixture>>['runtime'],
  params: Record<string, unknown> = {},
  signal?: AbortSignal
) =>
  runtime.request('runtime.remotes.readCatalog', params, {
    signal,
  }) as Promise<RemoteCapabilityCatalog>

describe('actual runtime remote catalog read boundary', () => {
  test('bounds target inventory before building rows and never opens any connection', async () => {
    const createClient = vi.fn()
    const runtime = createTestGatewayRuntime('owned', {
      loadServers: async () =>
        Array.from({ length: 1025 }, (_, i) => localGatewayServer({ id: `target-${i}` })),
      createClient,
    })
    try {
      await expect(read(runtime)).rejects.toMatchObject({ code: 'REMOTE_CATALOG_TOO_LARGE' })
      expect(createClient).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })
  test('unchanged observations still expire their pagination snapshot after one minute', async () => {
    const f = await fixture()
    try {
      vi.useFakeTimers()
      const original = await read(f.runtime)
      vi.setSystemTime(Date.now() + 60001)
      await expect(read(f.runtime, { cursor: original.nextCursor })).rejects.toMatchObject({
        code: 'REMOTE_CATALOG_CURSOR_STALE',
      })
    } finally {
      vi.useRealTimers()
      await f.runtime.dispose()
    }
  })
  test('unobserved/offline targets do not connect, select the first server, or infer a native owner', async () => {
    const f = await fixture(false)
    try {
      const initial = await read(f.runtime)
      expect(f.createClient).not.toHaveBeenCalled()
      expect(f.runtime.selectedServer).toBeNull()
      expect(initial.entries.find(row => row.capability === 'native.protocol')).toMatchObject({
        state: 'unknown',
        nativeOwner: null,
      })
      expect(initial.entries.find(row => row.capability === 'acp.outbound')).toMatchObject({
        state: 'unavailable',
        reasonCode: 'ACP_OUTBOUND_RUNNER_NOT_REGISTERED',
      })
      expect(initial.entries.find(row => row.capability === 'acp.inbound')).toMatchObject({
        state: 'unknown',
        businessState: 'unknown',
      })
      f.server.status = 'offline'
      expect((await read(f.runtime)).entries[0].state).toBe('unavailable')
    } finally {
      await f.runtime.dispose()
    }
  })
  test('fixed ten-page projection retains exact observed native owner without private paths or execution readiness', async () => {
    const f = await fixture()
    try {
      const before = f.client.requests.length
      const initial = await read(f.runtime)
      expect(initial.entries).toHaveLength(10)
      expect(initial.nextCursor).toBeTruthy()
      const all = [...initial.entries]
      let cursor = initial.nextCursor
      while (cursor) {
        const next = await read(f.runtime, { cursor })
        expect(next.snapshotId).toBe(initial.snapshotId)
        expect(next.entries.length).toBeLessThanOrEqual(10)
        all.push(...next.entries)
        cursor = next.nextCursor
      }
      expect(all.length).toBe(initial.total)
      expect(new Set(all.map(entry => entry.id)).size).toBe(all.length)
      expect(all.find(row => row.capability === 'cap0')).toMatchObject({
        state: 'advertised',
        businessState: 'unknown',
        nativeOwner: { accountId: 'native-owner', targetId: 'actual-native-target' },
        identityState: 'observed',
      })
      expect(all.find(row => row.capability === 'cap2')?.state).toBe('unavailable')
      expect(f.client.requests).toHaveLength(before)
      expect(f.createClient).toHaveBeenCalledTimes(1)
      const output = JSON.stringify(all)
      for (const privateValue of [
        'private-host',
        'declared-not-authenticated',
        'private/workspace',
        'private-command',
        'private-profile',
        'stored-hint',
        'secret-fixture-token',
      ])
        expect(output).not.toContain(privateValue)
      initial.entries[0].nativeOwner!.accountId = 'caller-mutation'
      expect(
        (await read(f.runtime, { cursor: initial.nextCursor })).entries[0].nativeOwner!.accountId
      ).toBe('native-owner')
    } finally {
      await f.runtime.dispose()
    }
  })
  test.each(['scope', 'connection', 'profile', 'account', 'epoch', 'generation'] as const)(
    'rejects old cursor after %s changes',
    async cause => {
      const f = await fixture()
      try {
        const original = await read(f.runtime)
        if (cause === 'scope') f.client.observation!.nativeScope!.identityGeneration = 'changed'
        if (cause === 'connection') f.client.observation!.connectionId = 'rpc-new-connection'
        if (cause === 'profile') f.server.profile = 'new-private-profile'
        if (cause === 'account') notifyAccountContextChange(f.server.id)
        if (cause === 'epoch') f.runtime.accountEpochByTarget.set(f.server.id, {})
        if (cause === 'generation') f.runtime.workspaceScanGeneration++
        await expect(read(f.runtime, { cursor: original.nextCursor })).rejects.toMatchObject({
          code: 'REMOTE_CATALOG_CURSOR_STALE',
        })
      } finally {
        await f.runtime.dispose()
      }
    }
  )
  test('closed and legacy clients stay unknown, and caller JSON cannot substitute negotiation facts', async () => {
    const f = await fixture()
    try {
      f.client.observation = null
      expect((await read(f.runtime)).entries[0].state).toBe('unknown')
      await expect(read(f.runtime, { capabilities: { paidTasks: true } })).rejects.toMatchObject({
        code: 'REMOTE_CATALOG_REQUEST_INVALID',
      })
      await expect(read(f.runtime, { cursor: 'not-an-owned-cursor' })).rejects.toMatchObject({
        code: 'REMOTE_CATALOG_CURSOR_STALE',
      })
      f.client.close()
      expect((await read(f.runtime)).entries[0].nativeOwner).toBeNull()
    } finally {
      await f.runtime.dispose()
    }
  })
  test('cancellation and a bounded metadata wait never create an execution connection', async () => {
    vi.useFakeTimers()
    let release!: (value: ReturnType<typeof localGatewayServer>[]) => void
    const createClient = vi.fn()
    const runtime = createTestGatewayRuntime('owned', {
      loadServers: () =>
        new Promise(resolve => {
          release = resolve
        }),
      createClient,
    })
    try {
      const abort = new AbortController()
      const pending = read(runtime, {}, abort.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      abort.abort()
      await rejected
      const timed = expect(read(runtime)).rejects.toMatchObject({ code: 'REMOTE_CATALOG_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(5001)
      await timed
      expect(createClient).not.toHaveBeenCalled()
      release([localGatewayServer()])
    } finally {
      vi.useRealTimers()
      await runtime.dispose()
    }
  })
})
