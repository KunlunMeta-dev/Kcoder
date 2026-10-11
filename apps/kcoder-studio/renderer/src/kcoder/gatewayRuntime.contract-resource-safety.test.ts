import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'

// The production adapter must use the same already-hardened resource owners as
// the standalone core, rather than retaining an older inline resource runtime.
describe.each([
  ['installed', InstalledRuntime],
  ['shared', CoreRuntime],
] as const)('gateway shared resource safety (%s)', (_entry, Runtime) => {
  const runtimes = new Set<CoreRuntime>()
  const server = {
    id: 'local',
    label: 'Local',
    transport: 'local' as const,
    workspacePath: '/workspace',
  }
  const create = (createClient: () => FakeGatewayClient, loadServers = async () => [server]) => {
    const runtime = new Runtime('token', { createClient, loadServers })
    runtimes.add(runtime)
    return runtime
  }
  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
    runtimes.clear()
    vi.restoreAllMocks()
  })

  test('coalesces a concurrent browser open before resolving its target', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const client = new FakeGatewayClient('browser')
    const connect = vi.fn(() => client)
    const runtime = create(connect, async () => {
      await gate
      return [server]
    })
    const first = runtime.openBrowser({ label: 'one', url: 'https://example.test' })
    const second = runtime.openBrowser({ label: 'one', url: 'https://example.test' })
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(client.requests.filter(request => request.method === 'browser/start')).toHaveLength(1)
  })

  test('reserves browser capacity while all target lookups are pending', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const clients: FakeGatewayClient[] = []
    const runtime = create(
      () => {
        const client = new FakeGatewayClient(`browser-${clients.length}`)
        clients.push(client)
        return client
      },
      async () => {
        await gate
        return [server]
      }
    )
    const openings = Array.from({ length: 4 }, (_, index) =>
      runtime.openBrowser({ label: String(index), url: 'https://example.test' })
    )
    try {
      await expect(
        runtime.openBrowser({ label: 'overflow', url: 'https://example.test' })
      ).rejects.toThrow('最多同时打开 4 个会话')
    } finally {
      release()
    }
    await Promise.all(openings)
    expect(clients).toHaveLength(4)
  })

  test('bounds queued terminal output in UTF-8 bytes without damaging characters', async () => {
    const client = new FakeGatewayClient('terminal')
    const runtime = create(() => client)
    const session = await runtime.startTerminal('local', '/workspace')
    client.emitNotification('terminal/output', {
      session_id: 'terminal-terminal',
      data: '你'.repeat(100_000),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const chunks: string[] = []
    const terminal = runtime.createTerminalClient(session.session_id)
    terminal.onOutput(event => chunks.push(event.data))
    await terminal.attach()
    expect(chunks.join('')).toBe('你'.repeat(87_381))
    expect(new TextEncoder().encode(chunks.join(''))).toHaveLength(262_143)
  })

  test('rejects late output after close fails and permits a newly assigned wire id', async () => {
    const client = new FakeGatewayClient('terminal')
    const runtime = create(() => client)
    const session = await runtime.startTerminal('local', '/workspace')
    const terminal = runtime.createTerminalClient(session.session_id)
    const oldOutput = vi.fn()
    terminal.onOutput(oldOutput)
    const request = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation((method, params) => {
      if (method === 'terminal/close') return Promise.reject(new Error('close rejected'))
      return request(method, params)
    })
    await expect(terminal.close()).rejects.toThrow('close rejected')
    expect(() => runtime.createTerminalClient(session.session_id)).toThrow('不存在')
    client.emitNotification('terminal/output', { session_id: 'terminal-terminal', data: 'stale' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const next = await runtime.startTerminal('local', '/workspace')
    const output = vi.fn()
    runtime.createTerminalClient(next.session_id).onOutput(output)
    client.emitNotification('terminal/output', { session_id: 'terminal-terminal', data: 'fresh' })
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith({ session_id: next.session_id, data: 'fresh' })
    )
    expect(oldOutput).not.toHaveBeenCalled()
  })
})
