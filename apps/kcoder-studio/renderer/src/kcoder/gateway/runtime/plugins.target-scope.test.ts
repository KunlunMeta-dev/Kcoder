import { afterEach, expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import type { GatewayClient } from '../../gatewayRuntimeTypes'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

function fixture(method = 'mcp/list') {
  const target = { ...localGatewayServer(), id: 'plugin-explicit', profile: 'original' }
  const client = Object.assign(new FakeGatewayClient(null), {
    diagnosticConnection: { targetId: target.id, connectionId: 'original' },
  })
  const invoke = vi.spyOn(client, 'request').mockResolvedValue({ servers: [] })
  const runtime = createTestGatewayRuntime('plugin-owned', {
    loadServers: async () => [target], createClient: () => client,
  })
  cleanups.push(() => runtime.disposeAsync())
  const discover = vi.spyOn(runtime, 'serverForParams')
  const connect = vi.spyOn(runtime, 'commandClient')
  const selected = vi.spyOn(runtime, 'server')
  const request = () => runtime.request('runtime.plugins.request', {
    deviceId: target.id, workspacePath: '/owned/plugin', method, params: {},
  })
  return { runtime, target, client, invoke, discover, connect, selected, request }
}

test.each(['mcp/list', 'plugin/list', 'plugin/uninstall'])('%s discovers only its explicit target once', async method => {
  const f = fixture(method)
  f.selected.mockRejectedValue(new Error('unrelated default is unavailable'))
  await expect(f.request()).resolves.toEqual({ servers: [] })
  expect(f.selected).not.toHaveBeenCalled()
  expect(f.discover).toHaveBeenCalledOnce()
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith(method, {})
})

test('one plugin read has one target lookup and no default selection lookup', async () => {
  const f = fixture()
  await f.request()
  expect({ default: f.selected.mock.calls.length, explicit: f.discover.mock.calls.length })
    .toEqual({ default: 0, explicit: 1 })
})

test.each(['discovery', 'connection', 'reply'] as const)('configuration retirement during %s prevents continuation or publication', async phase => {
  const f = fixture('plugin/uninstall')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  if (phase === 'discovery') f.discover.mockImplementationOnce(async () => { entered(); await gate; return f.target })
  if (phase === 'connection') f.connect.mockImplementationOnce(async () => { entered(); await gate; return f.client as GatewayClient })
  if (phase === 'reply') f.invoke.mockImplementationOnce(async () => { entered(); await gate; return {} })
  const pending = f.request().catch(error => error)
  try {
    await ready
    f.runtime.configurationEpochByTarget.set(f.target.id, {})
    release()
    expect(await pending).toMatchObject({ code: -32049, data: { kind: 'plugin_scope_changed' } })
    expect(f.invoke).toHaveBeenCalledTimes(phase === 'reply' ? 1 : 0)
  } finally { release(); await pending }
})

test.each([['disconnected', 'success'], ['disconnected', 'failure'], ['replaced', 'success'], ['replaced', 'failure']] as const)('a %s original client cannot publish a late %s', async (kind, outcome) => {
  const f = fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.invoke.mockImplementationOnce(async () => {
    entered(); await gate
    if (outcome === 'failure') throw new Error('old client failed')
    return { servers: [] }
  })
  const pending = f.request().catch(error => error)
  try {
    await ready
    if (kind === 'disconnected') f.runtime.appServerDisconnectedClients.add(f.client)
    else f.client.diagnosticConnection.connectionId = 'replacement'
    release()
    expect(await pending).toMatchObject({ code: -32049, data: { kind: 'plugin_scope_changed' } })
    expect(f.invoke).toHaveBeenCalledOnce()
  } finally { release(); await pending }
})

test('unrelated target retirement leaves a current explicit request usable', async () => {
  const f = fixture()
  f.connect.mockImplementationOnce(async () => {
    f.runtime.configurationEpochByTarget.set('unrelated', {})
    return f.client as GatewayClient
  })
  await expect(f.request()).resolves.toEqual({ servers: [] })
  expect(f.invoke).toHaveBeenCalledOnce()
})

test('a current Native failure stays unchanged and a later call reads again', async () => {
  const f = fixture(), failure = new Error('current Native failure')
  f.invoke.mockRejectedValueOnce(failure)
  await expect(f.request()).rejects.toBe(failure)
  await expect(f.request()).resolves.toEqual({ servers: [] })
  expect(f.invoke).toHaveBeenCalledTimes(2)
})
