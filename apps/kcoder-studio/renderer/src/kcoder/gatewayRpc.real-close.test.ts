import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { GatewayRpcClient } from './gatewayRpc'
import { pluginProxyErrorMessageKey } from './gatewayPluginApi'

const require = createRequire(resolve(process.cwd(), '../package.json'))
const { WebSocket: NodeWebSocket, WebSocketServer } = require('ws')

function withDeadline<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return new Promise<T>((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture timeout')), ms)
    promise.then(value => { clearTimeout(timer); resolveResult(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

afterEach(() => { delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })

test('management disconnect and unconfirmed writes do not disrupt the ordinary socket or replay', async () => {
  const http = createServer()
  const server = new WebSocketServer({ server: http })
  await new Promise<void>(resolveListen => http.listen(0, '127.0.0.1', resolveListen))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  const sockets = new Set<InstanceType<typeof NodeWebSocket>>()
  const managementFrames: string[] = []
  let managementConnections = 0
  let writes = 0
  let managementClosed!: () => void
  const closed = new Promise<void>(resolveClosed => { managementClosed = resolveClosed })
  server.on('connection', (socket: InstanceType<typeof NodeWebSocket>, req: { url: string }) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket); if (req.url.includes('nativeManagement=1')) managementClosed() })
    if (req.url.includes('nativeManagement=1')) {
      const number = ++managementConnections
      socket.on('message', (raw: Buffer) => {
        managementFrames.push(raw.toString())
        const frame = JSON.parse(raw.toString())
        if (frame.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: { protocolVersion: '2026-07-27', capabilities: { experimental: {} } } }))
        if (frame.method === 'plugin/proxy/configure') { writes++; if (number === 2) socket.close(1000, 'owned fixture') }
        if (frame.method === 'plugin/proxy/status') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }))
      })
      if (number === 1) socket.close(1000, 'owned fixture')
      return
    }
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.id === undefined) return
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: message.method === 'initialize'
          ? { protocolVersion: '2026-07-27', capabilities: { experimental: {} } }
          : { ok: true },
      }))
    })
  })
  class OwnedSocket extends NodeWebSocket {
    constructor(input: string | URL) {
      const url = new URL(String(input)); url.protocol = 'ws:'; url.host = `127.0.0.1:${address.port}`
      super(url)
    }
  }
  const ordinary = new GatewayRpcClient('target', 'fixture', OwnedSocket as typeof WebSocket)
  const manager = new GatewayRpcClient('target', 'fixture', OwnedSocket as typeof WebSocket)
  const writer = new GatewayRpcClient('target', 'fixture', OwnedSocket as typeof WebSocket)
  const timeoutWriter = new GatewayRpcClient('target', 'fixture', OwnedSocket as typeof WebSocket)
  manager.useNativeManagementTransport(); writer.useNativeManagementTransport(); timeoutWriter.useNativeManagementTransport()
  try {
    await withDeadline(ordinary.connect())
    let release!: (value: { isolatedHtml: boolean }) => void
    const capability = new Promise<{ isolatedHtml: boolean }>(resolveCapability => { release = resolveCapability })
    ;(window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost = { widgets: { getCapabilities: () => capability } }
    const pending = manager.connect().then(() => null, error => error)
    await withDeadline(closed)
    release({ isolatedHtml: false })
    expect(await withDeadline(pending)).toMatchObject({ reason: 'connection' })
    expect(managementFrames).toEqual([])
    expect(await withDeadline(ordinary.request('plugin/proxy/status'))).toEqual({ ok: true })
    delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
    await withDeadline(writer.connect())
    await expect(withDeadline(writer.request('plugin/proxy/configure', { enabled: true }))).rejects.toMatchObject({ reason: 'connection' })
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(writes).toBe(1)
    expect(managementFrames.filter(raw => JSON.parse(raw).method === 'plugin/proxy/configure')).toHaveLength(1)
    expect(await withDeadline(ordinary.request('plugin/proxy/status'))).toEqual({ ok: true })
    await withDeadline(timeoutWriter.connect())
    const timeout = await timeoutWriter.request('plugin/proxy/configure', { enabled: true }, { timeoutMs: 50 }).then(() => null, error => error)
    expect(timeout).toMatchObject({ reason: 'timeout', data: { outcome: 'unknown' } })
    expect(pluginProxyErrorMessageKey(timeout, true)).toBe('pluginNetwork.autoProxyWriteUnconfirmed')
    expect(await withDeadline(timeoutWriter.request('plugin/proxy/status'))).toEqual({ ok: true })
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(writes).toBe(2)
    expect(managementFrames.filter(raw => JSON.parse(raw).method === 'plugin/proxy/configure')).toHaveLength(2)
    expect(await withDeadline(ordinary.request('plugin/proxy/status'))).toEqual({ ok: true })
  } finally {
    timeoutWriter.close(); writer.close(); manager.close(); ordinary.close()
    for (const socket of sockets) socket.terminate()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await new Promise<void>(resolveClose => http.close(() => resolveClose()))
  }
})

test.each([200, 401])('failed real WS handshakes probe the session once per attempt (HTTP %s)', async status => {
  let handshakes = 0
  let directoryReads = 0
  const http = createServer((_request, response) => {
    directoryReads++
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ servers: [{ id: 'owned-failed-target', transport: 'local', label: 'Fixture' }] }))
  })
  http.on('upgrade', (_request, socket) => {
    handshakes++
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>(resolveListen => http.listen(0, '127.0.0.1', resolveListen))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  class OwnedSocket extends NodeWebSocket {
    constructor(input: string | URL) {
      const url = new URL(String(input)); url.protocol = 'ws:'; url.host = `127.0.0.1:${address.port}`
      super(url)
    }
  }
  const fetchDirectory: typeof fetch = (input, init) => fetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init)
  const client = new GatewayRpcClient('owned-failed-target', 'fixture', OwnedSocket as typeof WebSocket, 'runtime', undefined, fetchDirectory)
  try {
    await expect(withDeadline(client.request('thread/list', {}), 8000)).rejects.toBeInstanceOf(Error)
    expect(handshakes).toBe(status === 401 ? 1 : 4)
    expect(directoryReads).toBe(handshakes)
  } finally {
    client.close()
    await new Promise<void>(resolveClose => http.close(() => resolveClose()))
  }
}, 12_000)
