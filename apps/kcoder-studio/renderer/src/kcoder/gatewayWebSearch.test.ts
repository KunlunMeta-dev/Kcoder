import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
const runtimes: KCoderGatewayRuntime[] = []
const status = { targetId: 'native-target', revision: 'r1', mode: 'kcoder', automatic: true, webSearchVisible: true, webFetchVisible: true, candidates: [], observations: [] }
function fixture() {
  const client = new FakeGatewayClient(null)
  const fallback = client.request.bind(client)
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) => method.startsWith('webSearch/') ? status : fallback(method, params))
  const supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => ['webSearchStatusV1', 'webSearchProbeV1'].includes(name))
  const connections: string[] = []
  const runtime = new KCoderGatewayRuntime('fixture-token', {
    loadServers: async () => [
      { id: 'local', label: 'Local', description: '', transport: 'local' },
      { id: 'remote', label: 'Remote', description: '', transport: 'ssh', host: 'owned.test', workspacePath: '/owned' },
    ],
    createClient: serverId => { connections.push(serverId); return client },
  })
  runtimes.push(runtime)
  return { runtime, request, supports, connections }
}
beforeEach(() => { localStorage.clear(); installTestTransport(() => undefined) })
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync())); vi.restoreAllMocks(); clearTestTransports() })
const read = { serverId: 'remote', method: 'webSearch/status/read', params: { mode: 'kcoder' } }
test('search status follows the selected SSH target and validates capability and closed inputs', async () => {
  const { runtime, request, supports, connections } = fixture()
  await expect(runtime.request('runtime.webSearch.request', read)).resolves.toEqual(status)
  expect(connections).toEqual(['remote'])
  expect(request).toHaveBeenLastCalledWith('webSearch/status/read', { mode: 'kcoder' })
  const count = request.mock.calls.length
  await expect(runtime.request('runtime.webSearch.request', { ...read, method: 'webSearch/settings/save' })).rejects.toThrow('INVALID_REQUEST')
  await expect(runtime.request('runtime.webSearch.request', { ...read, params: { mode: 'kcoder', query: 'private' } })).rejects.toThrow('INVALID_REQUEST')
  supports.mockReturnValue(false)
  await expect(runtime.request('runtime.webSearch.request', read)).rejects.toThrow('UNSUPPORTED')
  expect(request).toHaveBeenCalledTimes(count)
})
test('command clients cannot inspect an unowned thread and account changes fence late results', async () => {
  const { runtime, request } = fixture()
  await expect(runtime.request('runtime.webSearch.request', { ...read, params: { mode: 'kcoder', threadId: 'peer-thread' } })).rejects.toThrow('THREAD_OWNER_REQUIRED')
  let finish!: (value: typeof status) => void
  request.mockImplementation(async method => method === read.method ? new Promise(resolve => { finish = resolve }) : {})
  const pending = runtime.request('runtime.webSearch.request', read)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  notifyAccountContextChange('remote')
  finish(status)
  await expect(pending).rejects.toThrow(/TARGET_CHANGED|invalidated/)
})
