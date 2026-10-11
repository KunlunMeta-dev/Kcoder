import { afterEach, describe, expect, test, vi } from 'vitest'
import { GatewayBrowserRuntime } from './gatewayBrowserRuntime'
import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

const server: GatewayServer = {
  id: 'local',
  label: '本机',
  description: '本机',
  runtime: 'kcoder',
  transport: 'local',
  workspacePath: '/workspace',
}

class BrowserClient extends EventTarget implements GatewayClient {
  readonly request = vi.fn(async <T>(method: string) => {
    if (method === 'browser/start') {
      return { session_id: `session-${Math.random()}`, url: 'https://example.test/' } as T
    }
    if (method === 'browser/screenshot') {
      return {
        session_id: '',
        data_base64: 'AA==',
        mime_type: 'image/png',
      } as T
    }
    return {} as T
  })
  readonly close = vi.fn()
  supportsExperimental() {
    return true
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  document
    .querySelectorAll('[data-testid="kcoder-remote-browser-surface"]')
    .forEach(node => node.remove())
  vi.restoreAllMocks()
})

describe('Gateway browser runtime concurrent reservations', () => {
  test('coalesces concurrent opens for the same label into one browser session', async () => {
    const gate = deferred<GatewayServer>()
    const client = new BrowserClient()
    const resolveServer = vi.fn(() => gate.promise)
    const connectClient = vi.fn(async () => client)
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: resolveServer,
      connectBrowserClient: connectClient,
    })

    const first = runtime.openBrowser({ label: 'shared', url: 'https://example.test/' })
    const second = runtime.openBrowser({ label: 'shared', url: 'https://example.test/other' })
    gate.resolve(server)

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.test/' }),
      expect.objectContaining({ url: 'https://example.test/' }),
    ])
    expect(resolveServer).toHaveBeenCalledTimes(1)
    expect(connectClient).toHaveBeenCalledTimes(1)
    expect(client.request.mock.calls.filter(([method]) => method === 'browser/start')).toHaveLength(
      1
    )
    await runtime.dispose()
  })

  test('reserves the four-session capacity across concurrent labels', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<GatewayServer>>>()
    const clients: BrowserClient[] = []
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: label => {
        const gate = deferred<GatewayServer>()
        gates.set(label, gate)
        return gate.promise
      },
      connectBrowserClient: async () => {
        const client = new BrowserClient()
        clients.push(client)
        return client
      },
    })

    const openings = Array.from({ length: 4 }, (_, index) =>
      runtime.openBrowser({ label: `browser-${index}`, url: 'https://example.test/' })
    )
    await expect(
      runtime.openBrowser({ label: 'browser-overflow', url: 'https://example.test/' })
    ).rejects.toThrow('最多同时打开 4 个会话')
    for (const gate of gates.values()) gate.resolve(server)
    await expect(Promise.all(openings)).resolves.toHaveLength(4)
    expect(clients).toHaveLength(4)
    await runtime.dispose()
  })

  test('releases a failed RPC reservation so the label and capacity can be retried', async () => {
    const failed = new BrowserClient()
    failed.request.mockRejectedValueOnce(new Error('browser start failed'))
    const recovered = new BrowserClient()
    const clients = [failed, recovered]
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: async () => server,
      connectBrowserClient: async () => clients.shift()!,
    })

    await expect(
      runtime.openBrowser({ label: 'retry', url: 'https://example.test/' })
    ).rejects.toThrow('browser start failed')
    expect(failed.close).toHaveBeenCalledOnce()
    await expect(
      runtime.openBrowser({ label: 'retry', url: 'https://example.test/' })
    ).resolves.toMatchObject({ url: 'https://example.test/' })
    await runtime.dispose()
  })
})
