import { afterEach, expect, test, vi } from 'vitest'
import { GatewayRpcClient } from './gatewayRpc'

class Socket extends EventTarget {
  static instances: Socket[] = []
  readyState = WebSocket.CONNECTING
  sent: Array<{ id: number; method: string }> = []
  constructor() {
    super()
    Socket.instances.push(this)
    queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event('open')) })
  }
  send(raw: string) {
    const frame = JSON.parse(raw)
    this.sent.push(frame)
    if (frame.method === 'initialize') queueMicrotask(() => this.reply(frame.id, { protocolVersion: '2026-07-27', capabilities: { threadResume: true, experimental: { migrationHistoryViewV1: true } } }))
  }
  reply(id: number, result: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })) }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')) }
}

afterEach(() => { Socket.instances = []; vi.restoreAllMocks() })
const client = () => new GatewayRpcClient('owned-target', '', Socket as unknown as typeof WebSocket, 'runtime', '/owned', vi.fn(async () => new Response('{}')))

test('a bound resource request uses only the current open channel', async () => {
  const rpc = client(); await rpc.connect()
  const owner = rpc.diagnosticConnection.connectionId
  const result = rpc.requestOnConnection(owner, 'migration/history/view/read', { requestId: 'owned' })
  const socket = Socket.instances[0], frame = socket.sent.at(-1)!
  socket.reply(frame.id, { lease: null })
  expect(await result).toEqual({ lease: null })
  expect(Socket.instances).toHaveLength(1)
  rpc.close()
})

test('close before cleanup never reconnects or sends to a replacement socket', async () => {
  const rpc = client(); await rpc.connect()
  const owner = rpc.diagnosticConnection.connectionId
  rpc.close()
  await expect(rpc.requestOnConnection(owner, 'migration/history/view/release', { requestId: 'old', leaseId: 'old' })).rejects.toThrow('connection_changed')
  expect(Socket.instances).toHaveLength(1)
  expect(Socket.instances.flatMap(socket => socket.sent).filter(frame => frame.method.endsWith('/release'))).toHaveLength(0)
})

test('an in-flight close rejects the old receipt and a later socket cannot acquire its cleanup', async () => {
  const rpc = client(); await rpc.connect()
  const owner = rpc.diagnosticConnection.connectionId, original = Socket.instances[0]
  const old = rpc.requestOnConnection(owner, 'migration/history/view/open', { requestId: 'old' }).catch(error => error)
  const oldId = original.sent.at(-1)!.id
  original.close()
  expect(await old).toBeInstanceOf(Error)
  await rpc.connect()
  expect(rpc.diagnosticConnection.connectionId).not.toBe(owner)
  await expect(rpc.requestOnConnection(owner, 'migration/history/view/release', { requestId: 'old', leaseId: 'old' })).rejects.toThrow('connection_changed')
  original.reply(oldId, { lease: { leaseId: 'late' } })
  expect(Socket.instances).toHaveLength(2)
  expect(Socket.instances[1].sent.filter(frame => frame.method.startsWith('migration/history/view/'))).toHaveLength(0)
  rpc.close()
})
