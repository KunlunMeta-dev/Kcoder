import { afterEach, expect, test } from 'vitest'
import { GatewayRpcClient } from './gatewayRpc'
import { SESSION_ADDRESS_EXPECTATION_CAPABILITY } from '../../../shared/sessionAddressExpectation.mjs'

class Socket extends EventTarget {
  static instances: Socket[] = []
  static supported = true
  readyState = WebSocket.CONNECTING
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  constructor() {
    super(); Socket.instances.push(this)
    queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event('open')) })
  }
  send(raw: string) {
    const frame = JSON.parse(raw); this.sent.push(frame)
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id,
      result: frame.method === 'initialize' ? { protocolVersion: '2026-07-27', capabilities: { threadResume: true,
        experimental: { [SESSION_ADDRESS_EXPECTATION_CAPABILITY]: Socket.supported } } } : {},
    }) })))
  }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')) }
}
const expected = { targetId: 'native-original', workspaceId: 'workspace-original', threadId: 'same-thread' }
const clients: GatewayRpcClient[] = []
const client = () => {
  const rpc = new GatewayRpcClient('alias', '', Socket as unknown as typeof WebSocket, 'runtime', '/workspace', async () => new Response('{}'))
  clients.push(rpc); return rpc
}
afterEach(() => { for (const rpc of clients.splice(0)) rpc.close(); Socket.instances = []; Socket.supported = true })

test('normal requests stay unchanged and a peer constraint is copied onto only its own thread', async () => {
  const rpc = client(); await rpc.connect()
  const original = { ...expected }; rpc.expectSessionAddress(original); original.targetId = 'forged-after-binding'
  await rpc.request('thread/read', { threadId: expected.threadId, limit: 1 })
  expect(Socket.instances[0].sent.at(-1)?.params).toEqual({ threadId: expected.threadId, limit: 1, expectedSessionAddress: expected })
  await rpc.request('thread/read', { threadId: 'ordinary-thread' })
  expect(Socket.instances[0].sent.at(-1)?.params).toEqual({ threadId: 'ordinary-thread' })
  await rpc.request('thread/agentMessage/targets', { sourceThreadId: expected.threadId })
  expect(Socket.instances[0].sent.at(-1)?.params.expectedSessionAddress).toEqual(expected)
})

test('a reconnect retains the original canonical selector and refuses an unsupported replacement Gateway', async () => {
  const rpc = client(); await rpc.connect(); rpc.expectSessionAddress(expected)
  Socket.instances[0].close(); await rpc.connect()
  await rpc.request('thread/resume', { threadId: expected.threadId })
  expect(Socket.instances[1].sent.at(-1)?.params.expectedSessionAddress).toEqual(expected)
  Socket.instances[1].close(); Socket.supported = false; await rpc.connect()
  await expect(rpc.request('thread/read', { threadId: expected.threadId })).rejects.toThrow('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED')
  expect(Socket.instances[2].sent.filter(frame => frame.method === 'thread/read')).toEqual([])
})

test('same alias and thread cannot replace an established canonical Native target or silently use an old Gateway', async () => {
  const rpc = client(); await rpc.connect(); rpc.expectSessionAddress(expected)
  expect(() => rpc.expectSessionAddress({ ...expected, targetId: 'replacement' })).toThrow('SESSION_ADDRESS_EXPECTATION_CONFLICT')
  Socket.supported = false
  const old = client(); await old.connect()
  expect(() => old.expectSessionAddress(expected)).toThrow('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED')
})
