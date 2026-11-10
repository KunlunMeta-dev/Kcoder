import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'

const runtimes = new Set<KCoderGatewayRuntime>()
const settings = () => ({
  persisted: {
    memoryCenterEnabled: null,
    publicationsEnabled: null,
    businessAutomationEnabled: null,
  },
  effective: {
    memoryCenterEnabled: false,
    publicationsEnabled: false,
    businessAutomationEnabled: false,
  },
  connection: {
    memoryCenterEnabled: false,
    publicationsEnabled: false,
    businessAutomationEnabled: false,
  },
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
      method.startsWith('settings/integrations/knowledge/') ? settings() : fallback(method, params)
    )
  const supported = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name === 'knowledgeSettingsV1')
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
  method: 'settings/integrations/knowledge/read',
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

test('feature setup uses the selected authenticated command client without enabling any domain', async () => {
  const { runtime, request, connections } = fixture()
  await expect(runtime.request('runtime.settings.request', read)).resolves.toEqual(settings())
  expect(connections).toEqual([{ serverId: 'remote', workspacePath: '/selected' }])
  expect(request).toHaveBeenCalledWith('settings/integrations/knowledge/read', {})
  const before = request.mock.calls.length
  for (const params of [
    { feature: 'all', enabled: true, expectedRevision: 'a'.repeat(64) },
    { feature: 'subscriptions', enabled: true, expectedRevision: 'a'.repeat(64), path: '/other' },
    { feature: 'subscriptions', enabled: 'true', expectedRevision: 'a'.repeat(64) },
  ])
    await expect(
      runtime.request('runtime.settings.request', {
        ...read,
        method: 'settings/integrations/knowledge/save',
        params,
      })
    ).rejects.toThrow('KNOWLEDGE_SETTINGS_INVALID_REQUEST')
  expect(request).toHaveBeenCalledTimes(before)
})
test('unsupported settings capability fails before sending a settings request', async () => {
  const { runtime, request, supported } = fixture()
  supported.mockReturnValue(false)
  await expect(runtime.request('runtime.settings.request', read)).rejects.toMatchObject({
    data: { kind: 'knowledge_settings_unsupported', capability: 'knowledgeSettingsV1' },
  })
  expect(
    request.mock.calls.some(([method]) => method.startsWith('settings/integrations/knowledge/'))
  ).toBe(false)
})
