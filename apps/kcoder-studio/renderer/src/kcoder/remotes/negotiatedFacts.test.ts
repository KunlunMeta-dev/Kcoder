import { afterEach, describe, expect, test } from 'vitest'
import { GatewayRpcClient } from '../gatewayRpc'

const scope = { accountId: 'real-native-owner', targetId: 'real-native-target', organizationId: null,
  workspaceId: 'opaque-workspace', identityGeneration: 'identity-1', targetRevision: 'revision-1' }
class OwnedSocket extends EventTarget {
  static all: OwnedSocket[] = []
  static caps: Record<string, boolean> = { integrationScopeV1: true, officeWorkspaceV1: true }
  readyState = WebSocket.CONNECTING
  readonly sent: { id: number; method: string; params?: Record<string, unknown> }[] = []
  constructor() { super(); OwnedSocket.all.push(this); queueMicrotask(() => {
    this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event('open'))
  }) }
  send(raw: string) {
    const frame = JSON.parse(raw); this.sent.push(frame)
    if (frame.method === 'initialize') queueMicrotask(() => this.reply(frame.id, {
      protocolVersion: '2026-07-27', serverInfo: { name: 'kcoder', version: '1.0.0' },
      capabilities: { experimental: OwnedSocket.caps },
    }))
  }
  reply(id: number, result: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) }))
  }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')) }
}
const clients: GatewayRpcClient[] = []
async function connected() {
  const client = new GatewayRpcClient('configured-alias', 'owned-fixture', OwnedSocket as unknown as typeof WebSocket)
  clients.push(client); await client.connect(); return client
}
afterEach(() => { for (const client of clients) client.close(); clients.length = 0; OwnedSocket.all = [];
  OwnedSocket.caps = { integrationScopeV1: true, officeWorkspaceV1: true } })

describe('private negotiation observations from the actual RPC client path', () => {
  test('metadata reads do not connect and handshake metadata is copied rather than caller-owned', async () => {
    const disconnected = new GatewayRpcClient('alias', 'owned', OwnedSocket as unknown as typeof WebSocket)
    clients.push(disconnected)
    expect(disconnected.readNegotiatedRemoteFacts()).toBeNull()
    expect(OwnedSocket.all).toHaveLength(0)
    await disconnected.connect()
    const actual = disconnected.readNegotiatedRemoteFacts()!
    expect(actual).toMatchObject({ protocolVersion: '2026-07-27', implementationName: 'kcoder', implementationVersion: '1.0.0', nativeScope: null })
    actual.capabilities.officeWorkspaceV1 = false
    expect(disconnected.readNegotiatedRemoteFacts()!.capabilities.officeWorkspaceV1).toBe(true)
    const before = OwnedSocket.all[0].sent.length
    disconnected.readNegotiatedRemoteFacts()
    expect(OwnedSocket.all[0].sent).toHaveLength(before)
  })
  test('only an actual matching and validated scope response supplies identity', async () => {
    const client = await connected(); const socket = OwnedSocket.all[0]
    const unrelated = client.request('some/read', { accountId: 'caller-invented' })
    socket.reply(socket.sent.at(-1)!.id, scope); await unrelated
    expect(client.readNegotiatedRemoteFacts()!.nativeScope).toBeNull()
    const invalid = client.request('integrations/scope/read', {})
    socket.reply(socket.sent.at(-1)!.id, { ...scope, extraAuthority: true }); await invalid
    expect(client.readNegotiatedRemoteFacts()!.nativeScope).toBeNull()
    const real = client.request('integrations/scope/read', {})
    socket.reply(socket.sent.at(-1)!.id, scope); await real
    expect(client.readNegotiatedRemoteFacts()!.nativeScope).toEqual(scope)
    expect(client.readNegotiatedRemoteFacts()!.nativeScope!.targetId).not.toBe(client.serverId)
  })
  test('socket loss clears identity and a later connection starts with no inherited scope', async () => {
    const client = await connected(); const first = OwnedSocket.all[0]
    const pending = client.request('integrations/scope/read', {})
    first.reply(first.sent.at(-1)!.id, scope); await pending
    const originalConnection = client.readNegotiatedRemoteFacts()!.connectionId
    first.close(); expect(client.readNegotiatedRemoteFacts()).toBeNull()
    await client.connect()
    expect(client.readNegotiatedRemoteFacts()!.connectionId).not.toBe(originalConnection)
    expect(client.readNegotiatedRemoteFacts()!.nativeScope).toBeNull()
    first.reply(first.sent.at(-1)!.id, scope)
    expect(client.readNegotiatedRemoteFacts()!.nativeScope).toBeNull()
  })
  test('invalid and oversized capability lists remain visibly incomplete without promoting business readiness', async () => {
    OwnedSocket.caps = { badName: true, ['bad\nname']: true,
      ...Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`cap${i}`, true])) }
    const client = await connected(); const actual = client.readNegotiatedRemoteFacts()!
    expect(Object.keys(actual.capabilities)).toHaveLength(512)
    expect(actual.capabilityListComplete).toBe(false)
    expect(actual.capabilities).not.toHaveProperty('bad\nname')
    expect(actual.nativeScope).toBeNull()
  })
})
