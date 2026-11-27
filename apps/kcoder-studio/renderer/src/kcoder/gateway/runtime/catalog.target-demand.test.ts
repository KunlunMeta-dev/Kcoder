import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '../../accountContextEvents'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import { SELECTED_SERVER_KEY } from './contracts'

function fixture() {
  const target = localGatewayServer({ id: 'catalog-explicit', workspacePath: '/owned/catalog' })
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
    ['computerUseStatusV1', 'usageHistory', 'sessionModes'].includes(capability))
  const native = vi.spyOn(client, 'request').mockResolvedValue({ value: 'current Native result' })
  const loadServers = vi.fn(async () => [target])
  const runtime = createTestGatewayRuntime('catalog-owned', { loadServers, createClient: () => client })
  const selected = vi.spyOn(runtime, 'server')
  const discover = vi.spyOn(runtime, 'serverForParams')
  vi.spyOn(runtime, 'withTransientClient').mockImplementation(async (_server, operation) => operation(client))
  return { target, client, native, loadServers, runtime, selected, discover }
}

test.each([
  ['get', false], ['update', false], ['get', true], ['update', true],
] as const)('local keybindings %s does not discover or choose a server (restart=%s)', async (operation, restarting) => {
  const f = fixture()
  f.runtime.restartingAppServers = restarting
  const restartGate = vi.spyOn(f.runtime, 'assertRequestTargetAvailable').mockRejectedValue(new Error('Native restart in progress'))
  localStorage.setItem(SELECTED_SERVER_KEY, 'unrelated-preference')
  f.selected.mockRejectedValue(new Error('default selection unavailable'))
  const keybindings = [{ command: 'task.new', shortcut: 'Ctrl+N' }]
  const result = await f.runtime.request(`runtime.keybindings.${operation}`, { keybindings })
  if (operation === 'update') expect(result).toEqual({ keybindings })
  else expect(result).toHaveProperty('keybindings')
  expect(f.selected).not.toHaveBeenCalled()
  expect(f.loadServers).not.toHaveBeenCalled()
  expect(f.native).not.toHaveBeenCalled()
  expect(restartGate).not.toHaveBeenCalled()
  expect(localStorage.getItem(SELECTED_SERVER_KEY)).toBe('unrelated-preference')
})

test.each([
  ['runtime.computerUse.status', 'computerUse/status'],
  ['runtime.usage.stats', 'usage/stats'],
  ['runtime.session.modes', 'session/modes'],
])('%s resolves its explicit target without consulting the default', async (method, rpc) => {
  const f = fixture()
  f.selected.mockRejectedValue(new Error('unrelated default unavailable'))
  await expect(f.runtime.request(method, { deviceId: f.target.id, serverId: f.target.id,
    workspacePath: f.target.workspacePath })).resolves.toEqual({ value: 'current Native result' })
  expect(f.selected).not.toHaveBeenCalled()
  expect(f.discover).toHaveBeenCalledOnce()
  expect(f.native).toHaveBeenCalledExactlyOnceWith(rpc, {})
  expect(f.runtime.selectedServer).toBeNull()
  expect(localStorage.getItem(SELECTED_SERVER_KEY)).toBeNull()
})

test('an implicit target still uses the existing default selection exactly once', async () => {
  const f = fixture()
  await f.runtime.request('runtime.session.modes', {})
  expect(f.selected).toHaveBeenCalledOnce()
  expect(f.runtime.selectedServer?.id).toBe(f.target.id)
  expect(f.native).toHaveBeenCalledExactlyOnceWith('session/modes', {})
})

test('unsupported methods keep their own error without querying a default target', async () => {
  const f = fixture()
  f.selected.mockRejectedValue(new Error('default selection unavailable'))
  await expect(f.runtime.request('runtime.unknown.catalog.operation', {})).rejects.toThrow('尚未实现运行时方法')
  expect(f.selected).not.toHaveBeenCalled()
  expect(f.loadServers).not.toHaveBeenCalled()
})

test('a task directory keeps its required default and existing scan owner', async () => {
  const f = fixture()
  const scan = vi.spyOn(f.runtime.taskListScans, 'read').mockResolvedValue({ workspaces: [] })
  await expect(f.runtime.request('runtime.tasks.list', {})).resolves.toEqual({ workspaces: [] })
  expect(f.selected).toHaveBeenCalledOnce()
  expect(scan).toHaveBeenCalledWith(f.target, {}, expect.any(Object))
})

test.each([
  ['known', false], ['fallback', false], ['known', true], ['fallback', true],
] as const)('%s sends resolve only the target they need (interrupt=%s)', async (mode, interrupt) => {
  const f = fixture(), entered = new Error('original send boundary')
  const send = vi.spyOn(f.runtime, 'sendTask').mockRejectedValue(entered)
  if (mode === 'known') {
    f.runtime.tasks.set('owned-task', { serverId: f.target.id, taskId: 'owned-task', threadId: 'owned-thread',
      workspacePath: f.target.workspacePath!, title: 'Owned', runtime: 'kcoder', persisted: true,
      running: false, createdAt: 0, updatedAt: 0, runtimeHandle: { threadId: 'owned-thread' } })
    f.selected.mockRejectedValue(new Error('unrelated default unavailable'))
  }
  const params = mode === 'known' ? { taskId: 'owned-task' } : {}
  await expect(f.runtime.request(interrupt ? 'runtime.tasks.interrupt_and_send' : 'runtime.tasks.send', params)).rejects.toBe(entered)
  expect(f.selected).toHaveBeenCalledTimes(mode === 'known' ? 0 : 1)
  expect(send).toHaveBeenCalledExactlyOnceWith(params, f.target, interrupt)
})

test('a current Native error stays unchanged and later reads are not cached', async () => {
  const f = fixture(), denied = new Error('current Native refusal')
  f.native.mockRejectedValueOnce(denied)
  const params = { serverId: f.target.id }
  await expect(f.runtime.request('runtime.usage.stats', params)).rejects.toBe(denied)
  await expect(f.runtime.request('runtime.usage.stats', params)).resolves.toEqual({ value: 'current Native result' })
  expect(f.native).toHaveBeenCalledTimes(2)
  expect(f.selected).not.toHaveBeenCalled()
})

test('account retirement while the required default is pending still prevents a task scan', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.selected.mockImplementationOnce(async () => { await gate; return f.target })
  const scan = vi.spyOn(f.runtime.taskListScans, 'read')
  const pending = f.runtime.request('runtime.tasks.list', {
    taskId: `kcoder:${f.target.id}:owned-thread`, expectedSessionAddress: {
      targetId: 'native-target', workspaceId: 'native-workspace', threadId: 'owned-thread',
    },
  }).catch(error => error)
  try {
    await vi.waitFor(() => expect(f.selected).toHaveBeenCalledOnce())
    notifyAccountContextChange(f.target.id)
    release()
    expect(await pending).toMatchObject({ message: 'SESSION_ADDRESS_EXPECTATION_OWNER_CHANGED' })
    expect(scan).not.toHaveBeenCalled()
  } finally { release(); await pending }
})
