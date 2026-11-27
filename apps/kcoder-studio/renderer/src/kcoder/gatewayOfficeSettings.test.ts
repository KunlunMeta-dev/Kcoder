import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { notifyAccountContextChange } from './accountContextEvents'

const runtimes = new Set<KCoderGatewayRuntime>()
const settings = () => ({
  persistedEnabled: false,
  effectiveEnabled: false,
  connectionEnabled: false,
  revision: 'a'.repeat(64),
  restartRequired: false,
})
function fixture() {
  const server = {
    id: 'remote',
    label: 'Remote',
    description: '',
    transport: 'ssh' as const,
    host: 'owned.test',
    workspacePath: '/default',
  }
  const client = new FakeGatewayClient(null)
  const fallback = client.request.bind(client)
  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method, params = {}) =>
      method.startsWith('settings/integrations/office/') ? settings() : fallback(method, params)
    )
  const supported = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name === 'officeSettingsV1')
  const connections: { serverId: string; workspacePath?: string }[] = []
  const runtime = new KCoderGatewayRuntime('owned-test-token', {
    loadServers: async () => [server],
    createClient: (serverId, _token, _channel, workspacePath) => {
      connections.push({ serverId, workspacePath })
      return client
    },
  })
  runtimes.add(runtime)
  return { runtime, client, request, supported, connections, server, fallback }
}
const read = {
  serverId: 'remote',
  workspacePath: '/selected',
  method: 'settings/integrations/office/read',
  params: {},
}
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  vi.restoreAllMocks()
  clearTestTransports()
})

test('Office settings use the real selected command client and stay available when officeWorkspace is disabled', async () => {
  const { runtime, request, connections } = fixture()
  await expect(runtime.request('runtime.settings.request', read)).resolves.toEqual(settings())
  expect(connections).toEqual([{ serverId: 'remote', workspacePath: '/selected' }])
  expect(request).toHaveBeenCalledWith('settings/integrations/office/read', {})
  const before = request.mock.calls.length
  for (const params of [
    { enabled: true, expectedRevision: 'a'.repeat(64), path: '/other' },
    { enabled: 'true', expectedRevision: 'a'.repeat(64) },
  ])
    await expect(
      runtime.request('runtime.settings.request', {
        ...read,
        method: 'settings/integrations/office/save',
        params,
      })
    ).rejects.toThrow('OFFICE_SETTINGS_INVALID_REQUEST')
  await expect(
    runtime.request('runtime.settings.request', { ...read, params: { path: '/not-an-input' } })
  ).rejects.toThrow('OFFICE_SETTINGS_INVALID_REQUEST')
  expect(request).toHaveBeenCalledTimes(before)
})

test('only the independent settings capability diagnoses an unsupported target before native forwarding', async () => {
  const { runtime, request, supported } = fixture()
  supported.mockReturnValue(false)
  await expect(runtime.request('runtime.settings.request', read)).rejects.toMatchObject({
    data: { kind: 'office_settings_unsupported', capability: 'officeSettingsV1' },
  })
  expect(
    request.mock.calls.some(([method]) => method === 'settings/integrations/office/read')
  ).toBe(false)
})

for (const targetId of ['remote', 'peer']) {
  test(`an unchanged Office owner keeps its original reply during a ${targetId} directory refresh`, async () => {
    const { runtime, request, client, fallback } = fixture()
    const entered = Promise.withResolvers<void>()
    const late = Promise.withResolvers<unknown>()
    request.mockImplementation(async (method, params = {}) => {
      if (method === 'settings/integrations/office/read') { entered.resolve(); return late.promise }
      return fallback(method, params)
    })
    const close = vi.spyOn(client, 'close')
    const pending = runtime.request('runtime.settings.request', read)
    await entered.promise
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId } }))
    late.resolve(settings())
    await expect(pending).resolves.toEqual(settings())
    expect(close).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(([method]) => method === 'settings/integrations/office/read')).toHaveLength(1)
  })
}

test('old account results are fenced after the actual native request and are not replayed', async () => {
  const { runtime, request, fallback } = fixture()
  const entered = Promise.withResolvers<void>()
  const late = Promise.withResolvers<unknown>()
  request.mockImplementation(async (method, params = {}) => {
    if (method === 'settings/integrations/office/read') {
      entered.resolve()
      return late.promise
    }
    return fallback(method, params)
  })
  const pending = runtime.request('runtime.settings.request', read)
  await entered.promise
  notifyAccountContextChange('remote')
  late.resolve(settings())
  await expect(pending).rejects.toThrow(/OFFICE_SETTINGS_TARGET_CHANGED|Workspace scan invalidated/)
  expect(
    request.mock.calls.filter(([method]) => method === 'settings/integrations/office/read')
  ).toHaveLength(1)
})

test('target descriptor changes and contradictory saved-state replies never confirm the old target', async () => {
  const { runtime, request, server, fallback } = fixture()
  request.mockImplementation(async (method, params = {}) => {
    if (method === 'settings/integrations/office/read') {
      server.host = 'different.test'
      return settings()
    }
    return fallback(method, params)
  })
  await expect(runtime.request('runtime.settings.request', read)).rejects.toThrow(
    'OFFICE_SETTINGS_TARGET_CHANGED'
  )
  request.mockImplementation(async (method, params = {}) =>
    method === 'settings/integrations/office/read'
      ? { ...settings(), restartRequired: true }
      : fallback(method, params)
  )
  await expect(runtime.request('runtime.settings.request', read)).rejects.toThrow(
    'OFFICE_SETTINGS_REPLY_INVALID'
  )
})
