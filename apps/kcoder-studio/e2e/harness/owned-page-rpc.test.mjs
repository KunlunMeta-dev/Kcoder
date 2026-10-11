import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { requestOwnedPageRpc } from './owned-page-rpc.mjs'

function fixture({ initializeError = false, connectError = false } = {}) {
  const sent = []
  let closed = 0
  class Socket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit(connectError ? 'error' : 'open', {})) }
    addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]) }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== callback)) }
    emit(name, event) { for (const callback of [...(this.listeners.get(name) ?? [])]) callback(event) }
    send(text) {
      const frame = JSON.parse(text); sent.push(frame)
      const response = frame.method === 'initialize' && initializeError
        ? { id: frame.id, error: { code: -1 } }
        : { id: frame.id, result: { accepted: frame.method } }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify(response) }))
    }
    close() { closed++ }
  }
  const page = { evaluate: (fn, args) => runInNewContext(`(${fn.toString()})(args)`, {
    args, document: { querySelector: () => ({ content: 'owned-fixture-token' }) },
    location: { href: 'http://127.0.0.1:12345/', host: '127.0.0.1:12345' },
    URL, WebSocket: Socket, setTimeout, clearTimeout,
  }) }
  return { page, sent, closed: () => closed }
}

test('owned page RPC initializes before its scoped operation and closes the socket', async () => {
  const setup = fixture()
  const result = await requestOwnedPageRpc(setup.page, { workspace: 'owned-workspace', requests: [
    { method: 'plugin/install', params: { marketplaceName: 'kcoder-bundled', pluginName: 'kcoder-windows-computer-use' } },
  ] })
  assert.equal(result[0].result.accepted, 'plugin/install')
  assert.deepEqual(setup.sent.map(frame => frame.method), ['initialize', 'plugin/install'])
  assert.equal(setup.closed(), 1)
})

for (const options of [{ initializeError: true }, { connectError: true }]) {
  test(`owned page RPC closes after ${Object.keys(options)[0]}`, async () => {
    const setup = fixture(options)
    await assert.rejects(requestOwnedPageRpc(setup.page, { workspace: 'owned-workspace', requests: [] }), /refused|connect failed/)
    assert.equal(setup.closed(), 1)
  })
}

test('owned page RPC rejects unexpected operations before sending them and closes', async () => {
  const setup = fixture()
  await assert.rejects(requestOwnedPageRpc(setup.page, { workspace: 'owned-workspace', requests: [{ method: 'turn/start', params: {} }] }), /Unexpected/)
  assert.deepEqual(setup.sent.map(frame => frame.method), ['initialize'])
  assert.equal(setup.closed(), 1)
})
