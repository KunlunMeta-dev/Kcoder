import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SshTerminalConnection, listSshConnections, saveSshConnection } from './sshTerminal'

class FakeSocket {
  static OPEN = 1
  static latest: FakeSocket
  readyState = 1
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: { id: number; method: string; params: Record<string, unknown> }[] = []
  readonly url: URL
  constructor(url: URL) {
    this.url = url
    FakeSocket.latest = this
    queueMicrotask(() => this.onopen?.())
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="fixture-token">'
})
afterEach(() => {
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
})

test('uses an independent Gateway channel and buffers early output until attach', async () => {
  const connection = new SshTerminalConnection()
  const pending = connection.connect('remote')
  await vi.waitFor(() => expect(FakeSocket.latest.sent).toHaveLength(1))
  const socket = FakeSocket.latest
  expect(socket.url.searchParams.get('channel')).toBe('ssh-terminal')
  expect(socket.url.searchParams.has('workspace')).toBe(false)
  socket.message({ method: 'ssh/output', params: { data: 'early prompt' } })
  socket.message({ id: socket.sent[0].id, result: { status: 'connected' } })
  await expect(pending).resolves.toEqual({ status: 'connected' })
  const terminal = connection.createTerminalClient('tab-1')
  const output = vi.fn()
  terminal.onOutput(output)
  await terminal.attach()
  expect(output).toHaveBeenCalledWith({ session_id: 'tab-1', data: 'early prompt' })
  connection.dispose()
})

test('returns host key challenge without persisting connection credentials in the browser', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem')
  const connection = new SshTerminalConnection()
  const pending = connection.connect('remote', { password: 'ephemeral-test-value' })
  await vi.waitFor(() => expect(FakeSocket.latest.sent).toHaveLength(1))
  FakeSocket.latest.message({
    id: 1,
    result: { status: 'host-key-required', fingerprint: 'SHA256:fixture' },
  })
  await expect(pending).resolves.toHaveProperty('status', 'host-key-required')
  expect(store).not.toHaveBeenCalled()
  connection.dispose()
  store.mockRestore()
})

test('rejects pending requests on disconnect and cannot silently reconnect', async () => {
  const onExit = vi.fn()
  const connection = new SshTerminalConnection(onExit)
  const pending = connection.connect('remote')
  const failure = expect(pending).rejects.toThrow('disconnected')
  await vi.waitFor(() => expect(FakeSocket.latest.sent).toHaveLength(1))
  FakeSocket.latest.close()
  await failure
  expect(onExit).toHaveBeenCalledOnce()
  await expect(connection.request('ssh/write', { data: 'never sent' })).rejects.toThrow()
})

test('profile CRUD uses authenticated same-origin HTTP and reports load failures', async () => {
  const profile = {
    id: 'one',
    label: 'One',
    host: 'localhost',
    port: 22,
    username: 'tester',
    authMethod: 'password' as const,
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [profile] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ connection: profile }) })
    .mockResolvedValueOnce({ ok: false, status: 403 })
  vi.stubGlobal('fetch', fetchMock)
  await expect(listSshConnections()).resolves.toEqual([profile])
  await expect(saveSshConnection(profile)).resolves.toEqual(profile)
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/ssh-connections/one',
    expect.objectContaining({ method: 'PUT', credentials: 'same-origin' })
  )
  await expect(listSshConnections()).rejects.toThrow('403')
})

test('an early SSH exit cannot be overwritten by a late connect acknowledgement', async () => {
  const connection = new SshTerminalConnection()
  const pending = connection.connect('remote')
  const failure = expect(pending).rejects.toThrow('closed before')
  await vi.waitFor(() => expect(FakeSocket.latest.sent).toHaveLength(1))
  FakeSocket.latest.message({ method: 'ssh/exit', params: {} })
  FakeSocket.latest.message({ id: 1, result: { status: 'connected' } })
  await failure
  connection.dispose()
})
