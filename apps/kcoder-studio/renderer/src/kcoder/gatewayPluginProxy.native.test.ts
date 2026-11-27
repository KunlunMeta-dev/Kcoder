import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { registerGatewayCommandTransport } from './gatewayServiceBridge'
import { createGatewayIpcHandler } from './gatewayRuntimeInstall'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { GatewayRpcClient } from './gatewayRpc'
import { createKCoderPluginApi } from './gatewayPluginApi'

test.skipIf(process.env.KCODER_E2E_PROXY_NATIVE_CHAIN !== '1')('actual target plugin proxy API uses production initialization and finite management RPCs', async () => {
  const base = process.env.KCODER_E2E_PROXY_GATEWAY!
  const cookie = process.env.KCODER_E2E_PROXY_COOKIE!
  const token = process.env.KCODER_E2E_PROXY_TOKEN!
  const workspace = process.env.KCODER_E2E_PROXY_WORKSPACE!
  const output = process.env.KCODER_E2E_PROXY_OUTPUT!
  const transport = process.env.KCODER_E2E_PROXY_TRANSPORT === 'ssh' ? 'ssh' : 'local'
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const require = createRequire(resolve(process.cwd(), 'package.json'))
  const { HeaderWebSocket } = require('../e2e/harness/header-websocket.mjs')
  const connections: Array<{ server: string | null; workspace: string | null; management: boolean; initialization?: unknown }> = []
  const methods: string[] = []
  class OwnedSocket extends HeaderWebSocket {
    record: typeof connections[number]
    constructor(input: string | URL) {
      const url = new URL(String(input))
      const record = { server: url.searchParams.get('server'), workspace: url.searchParams.get('workspace'), management: url.searchParams.get('nativeManagement') === '1' }
      url.protocol = 'ws:'; url.host = new URL(base).host
      super(url.href, { Cookie: cookie, Origin: base })
      this.record = record; connections.push(record)
    }
    send(raw: string) {
      const frame = JSON.parse(raw)
      methods.push(frame.method)
      if (frame.method === 'initialize') this.record.initialization = frame.params.capabilities.experimental
      return super.send(raw)
    }
  }
  const nativeFetch = globalThis.fetch
  const clients: GatewayRpcClient[] = []
  const runtime = new KCoderGatewayRuntime(token, {
    loadServers: async () => [{ id: 'h20-owned', label: 'H20 owned target', description: '', runtime: 'kcoder', transport, workspacePath: workspace }],
    createClient: (serverId, clientToken, channel, path) => {
      const client = new GatewayRpcClient(serverId, clientToken, OwnedSocket as unknown as typeof WebSocket, channel, path,
        (input, options) => nativeFetch(new URL(String(input), base), { ...options, headers: { ...options?.headers, Cookie: cookie } }))
      clients.push(client)
      return client
    },
  })
  const unregister = registerGatewayCommandTransport(createGatewayIpcHandler(runtime))
  let scopeCurrent = true
  const api = createKCoderPluginApi({} as LocalCodexPluginApi, {
    deviceId: 'h20-owned', workspacePath: workspace, isScopeCurrent: () => scopeCurrent,
  })
  try {
    // Hold a normal production client before the separate proxy control client.
    await runtime.request('runtime.plugins.request', { deviceId: 'h20-owned', workspacePath: workspace,
      method: 'plugin/list', params: { all: true } })
    const before = await api.getProxySettings!()
    const configured = await api.configureAutoProxy!(false)
    const after = await api.getProxySettings!()
    expect(before.autoDetect).toBe(false)
    expect(configured.autoDetect).toBe(false)
    expect(after.autoDetect).toBe(false)
    expect(after.status).toBe('disabled')
    expect(connections).toHaveLength(2)
    expect(connections.every(value => value.server === 'h20-owned' && value.workspace === workspace)).toBe(true)
    const management = connections.find(value => value.management)!
    expect(management.initialization).toMatchObject({ gatewaySharedThreadsV1: false, taskSourcesV1: false, threadRuntimeHandoffV1: false })
    const control = clients[connections.indexOf(management)]
    expect(control.supportsExperimental('pluginProxyDiscoveryV1')).toBe(true)
    for (const method of ['thread/start', 'turn/start', 'plugin/install', 'runtime.models.list', 'plugin/proxy/status/extra']) {
      const sent = methods.length
      await expect(control.request(method)).rejects.toThrow('cannot execute task commands')
      expect(methods).toHaveLength(sent)
    }
    scopeCurrent = false
    const sent = methods.length
    await expect(api.configureAutoProxy!(false)).rejects.toMatchObject({ data: { kind: 'plugin_scope_changed' } })
    expect(methods).toHaveLength(sent)
    await writeFile(output, JSON.stringify({ passed: true, connections, methods, before, configured, after,
      proxyCapability: true, normalConnectivityCapability: clients[0].supportsExperimental('connectivityV1'),
      exactTargetAndWorkspace: true, staleScopeWriteRefused: true, forbiddenMethodsRefused: true,
      modelTurnsStarted: 0, externalNetworkRequests: 0 }), { flag: 'wx' })
  } finally {
    unregister()
    await runtime.disposeAsync()
  }
}, 60000)
