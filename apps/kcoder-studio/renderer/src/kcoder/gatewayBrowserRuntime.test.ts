import { afterEach, describe, expect, test, vi } from 'vitest'
import { GatewayBrowserRuntime } from './gatewayBrowserRuntime'
import type { GatewayServer } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { notifyAccountContextChange } from './accountContextEvents'

const server: GatewayServer = {
  id: 'local',
  label: '本机',
  description: '本机',
  runtime: 'kcoder',
  transport: 'local',
  workspacePath: '/workspace',
}

class BrowserClient extends EventTarget implements GatewayClient {
  readonly request = vi.fn<GatewayClient["request"]>(async <T>(method: string) => {
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
  test('handoff uses revisions and reads original state after an unknown reply without resending', async () => {
    const client=new BrowserClient()
    let revision=1,mode:'automation'|'human'='automation',lost=true
    const metadata={draft:{id:'office',label:'Office',accountLabel:null,purpose:'business'},revision:1,archived:false}
    client.request.mockImplementation(async <T>(method:string,params?:unknown)=>{
      const value=params as Record<string,unknown>
      if(method==='browser/start') return {session_id:'owned-profile',url:'http://fixture.test/',profile:metadata} as T
      if(method==='browser/profile/handoff') {
        expect(value.expectedRevision).toBe(revision)
        revision+=1;mode=value.mode as typeof mode
        if(lost){lost=false;throw new Error('lost original reply')}
        return {sessionId:'owned-profile',revision,mode,observedUrl:'http://fixture.test/'} as T
      }
      if(method==='browser/profile/controlRead') return {sessionId:'owned-profile',revision,mode,observedUrl:'http://fixture.test/'} as T
      if(method==='browser/close') return {closed:true} as T
      return {} as T
    })
    const runtime=new GatewayBrowserRuntime({resolveServerForLabel:async()=>server,connectBrowserClient:async()=>client})
    await runtime.openBrowser({label:'control',url:'http://fixture.test/',profile})
    await expect(runtime.setHandoff('control','human')).rejects.toThrow('lost original reply')
    await expect(runtime.setHandoff('control','human')).rejects.toThrow('CONTROL_UNCONFIRMED')
    await expect(runtime.readHandoff('control')).resolves.toMatchObject({revision:2,mode:'human'})
    await runtime.setHandoff('control','automation')
    expect(client.request.mock.calls.filter(([method])=>method==='browser/profile/handoff')).toHaveLength(2)
    await runtime.dispose()
  })
  test('account switching requires confirmed original cleanup and preserves the old surface on failure', async () => {
    const client = new BrowserClient()
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: async () => server,
      connectBrowserClient: async () => client,
    })
    await runtime.openBrowser({ label: 'switch', url: 'https://example.test/' })
    await expect(runtime.closeForAccountSwitch('switch')).rejects.toThrow('CLEANUP_UNCONFIRMED')
    expect(document.querySelector('[data-browser-label="switch"]')).not.toBeNull()
    const original = client.request.getMockImplementation()!
    client.request.mockImplementation(async <T>(method: string, params?: unknown) =>
      method === 'browser/close' ? ({ closed: true } as T) : original<T>(method, params)
    )
    await runtime.closeForAccountSwitch('switch')
    expect(document.querySelector('[data-browser-label="switch"]')).toBeNull()
    await runtime.dispose()
  })
  const profile = {
    scope: {
      accountId: 'account',
      targetId: 'target',
      workspaceId: null,
      identityGeneration: 'g',
      targetRevision: 'r',
    },
    profileId: 'office',
    expectedRevision: 1,
    operationId: 'start-office',
  }

  test('refuses private paths before connecting and refuses an unsupported profile target', async () => {
    const client = new BrowserClient()
    const connect = vi.fn(async () => client)
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: async () => server,
      connectBrowserClient: connect,
    })
    await expect(
      runtime.openBrowser({
        label: 'invalid',
        url: 'https://example.test/',
        profile: { ...profile, path: '/private' },
      })
    ).rejects.toThrow('SELECTION_INVALID')
    expect(connect).not.toHaveBeenCalled()
    client.supportsExperimental = name => name !== 'browserProfileSessionsV1'
    await expect(
      runtime.openBrowser({ label: 'unsupported', url: 'https://example.test/', profile })
    ).rejects.toThrow('SESSION_UNAVAILABLE')
    expect(client.request.mock.calls.filter(([method]) => method === 'browser/start')).toHaveLength(
      0
    )
    await runtime.dispose()
  })

  test('does not coalesce two different account choices into the same pending label', async () => {
    const gate = deferred<GatewayServer>()
    const client = new BrowserClient()
    client.supportsExperimental = name => name !== 'browserProfileSessionsV1'
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: () => gate.promise,
      connectBrowserClient: async () => client,
    })
    const first = runtime.openBrowser({ label: 'choice', url: 'https://example.test/', profile })
    const failure = expect(first).rejects.toThrow('SESSION_UNAVAILABLE')
    await expect(
      runtime.openBrowser({
        label: 'choice',
        url: 'https://example.test/',
        profile: { ...profile, profileId: 'personal' },
      })
    ).rejects.toThrow('SELECTION_CHANGED')
    gate.resolve(server)
    await failure
    await runtime.dispose()
  })

  test('account invalidation during connection prevents a browser launch', async () => {
    const gate = deferred<GatewayClient>()
    const client = new BrowserClient()
    const runtime = new GatewayBrowserRuntime({
      resolveServerForLabel: async () => server,
      connectBrowserClient: () => gate.promise,
    })
    const opening = runtime.openBrowser({
      label: 'owner-change',
      url: 'https://example.test/',
      profile,
    })
    const failure = expect(opening).rejects.toThrow('OWNER_CHANGED')
    await Promise.resolve()
    notifyAccountContextChange(server.id)
    gate.resolve(client)
    await failure
    expect(client.request.mock.calls.filter(([method]) => method === 'browser/start')).toHaveLength(
      0
    )
    await runtime.dispose()
  })

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
