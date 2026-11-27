import { expect, test, vi } from 'vitest'
import { request } from './catalog'
import { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayServer } from '../../gatewayRpc'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { KCODER_RUNTIME_METHODS } from '../../legacyRuntimeAbi'

const settings = {
  profileRead: { method: 'settings/tools/read', params: {} },
  profileWrite: { method: 'settings/tools/save', params: { profile: 'nano' } },
  executionRead: { method: 'settings/execution-defaults/read', params: {} },
  executionWrite: { method: 'settings/execution-defaults/save', params: { permissionMode: 'ask' } },
  selectionRead: { method: 'settings/tools/selection/read', params: {} },
  selectionWrite: { method: 'settings/tools/selection/save', params: { mode: 'kcoder', allowedTools: ['Read'], expectedRevision: 'original' } },
} as const
const operations = ['personalityRead', 'personalityWrite', ...Object.keys(settings)] as
  Array<'personalityRead' | 'personalityWrite' | keyof typeof settings>
function fixture(operation: typeof operations[number]) {
  const target: GatewayServer = { id: 'explicit', label: 'Explicit', transport: 'local', profile: 'original' }
  const invoke = vi.fn(async () => ({ personality: 'friendly', profile: 'full' }))
  const client = { request: invoke, supportsExperimental: () => true,
    diagnosticConnection: { connectionId: 'original-settings-connection' }, close: vi.fn() }
  const core = { disposed: false, workspaceScanGeneration: 0, runtimeContextReads: new WeakMap(),
    configurationEpochByTarget: new Map(), accountEpochByTarget: new Map(), commandDirectoryRefresh: new Map(),
    appServerDisconnectedClients: new WeakSet(),
    compatibility: { matchesMethod: (method: string, key: keyof typeof KCODER_RUNTIME_METHODS) => method === KCODER_RUNTIME_METHODS[key] },
    server: vi.fn(async () => target), serverForParams: vi.fn(async () => target),
    commandClient: vi.fn(async () => client), sharedRuntimeContext: vi.fn(async () => invoke()),
  } as unknown as GatewayRuntimeCore
  core.captureReadSource = targetId => GatewayRuntimeCore.prototype.captureReadSource.call(core, targetId)
  const personality = operation.startsWith('personality')
  const method = personality ? KCODER_RUNTIME_METHODS[operation as 'personalityRead' | 'personalityWrite'] : 'runtime.settings.request'
  const params = personality ? { deviceId: target.id, personality: 'friendly', targetScope: hookTargetScope(target) }
    : { serverId: target.id, ...settings[operation as keyof typeof settings], targetScope: hookTargetScope(target) }
  return { target, core, invoke, client, method, params }
}

test.each(operations)('%s skips unrelated default-target discovery and keeps Native fields unchanged', async operation => {
  const f = fixture(operation)
  await request.call(f.core, f.method, f.params)
  expect(f.core.server).not.toHaveBeenCalled()
  expect(f.invoke).toHaveBeenCalledTimes(1)
  if (operation === 'personalityWrite') expect(f.invoke).toHaveBeenCalledWith('runtime.context.update', { personality: 'friendly' })
  if (operation in settings) {
    const expected = settings[operation as keyof typeof settings]
    expect(f.invoke).toHaveBeenCalledWith(expected.method, expected.params)
  }
})

test.each(operations)('%s rejects a stale same-ID editor before Native dispatch', async operation => {
  const f = fixture(operation)
  f.target.profile = 'replacement'
  await expect(request.call(f.core, f.method, f.params)).rejects.toMatchObject({ code: -32049 })
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(operations)('%s retires a late result without repeating the original operation', async operation => {
  const f = fixture(operation)
  let finish!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.invoke.mockImplementationOnce(async () => { entered(); await gate; return { personality: 'friendly', profile: 'full' } })
  const result = request.call(f.core, f.method, f.params).catch(error => error)
  await ready
  if (operation in settings) f.core.configurationEpochByTarget.set(f.target.id, {})
  else f.core.workspaceScanGeneration++
  finish()
  expect(await result).toMatchObject({ code: -32049, reason: 'unknown' })
  expect(f.invoke).toHaveBeenCalledTimes(1)
})

test.each([['profileWrite', 'discovery'], ['profileWrite', 'connection'], ['executionWrite', 'discovery'], ['executionWrite', 'connection'], ['selectionWrite', 'discovery'], ['selectionWrite', 'connection']] as const)('%s retirement during %s prevents Native dispatch', async (operation, phase) => {
  const f = fixture(operation)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  if (phase === 'discovery') vi.mocked(f.core.serverForParams).mockImplementationOnce(async () => { entered(); await gate; return f.target })
  else vi.mocked(f.core.commandClient).mockImplementationOnce(async () => { entered(); await gate; return f.client as never })
  const result = request.call(f.core, f.method, f.params).catch(error => error)
  await ready
  if (operation in settings) f.core.configurationEpochByTarget.set(f.target.id, {})
  else f.core.workspaceScanGeneration++
  release()
  expect(await result).toMatchObject({ code: -32049 })
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(operations)('%s supports existing callers that omit the optional owner hint', async operation => {
  const f = fixture(operation)
  const params: Record<string, unknown> = { ...f.params }
  delete params.targetScope
  await expect(request.call(f.core, f.method, params)).resolves.toBeDefined()
  expect(f.invoke).toHaveBeenCalledTimes(1)
})

test.each(['personalityWrite', 'profileWrite', 'executionWrite', 'selectionWrite'] as const)('%s preserves target restart isolation before dispatch', async operation => {
  const f = fixture(operation)
  f.core.restartingAppServers = true
  f.core.assertRequestTargetAvailable = vi.fn(async () => { throw new Error('restart-in-progress') })
  await expect(request.call(f.core, f.method, f.params)).rejects.toThrow('restart-in-progress')
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(['personalityRead', 'profileRead', 'executionRead', 'selectionRead'] as const)('%s performs another authoritative read after completion', async operation => {
  const f = fixture(operation)
  await request.call(f.core, f.method, f.params)
  await request.call(f.core, f.method, f.params)
  expect(f.invoke).toHaveBeenCalledTimes(2)
  expect(f.core.server).not.toHaveBeenCalled()
})


test.each(['discovery', 'connection', 'native'] as const)('a retired settings %s failure is scoped without replay', async phase => {
  const f = fixture('executionRead'), failure = new Error('old settings failure')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const fail = async () => { entered(); await gate; throw failure }
  if (phase === 'discovery') vi.mocked(f.core.serverForParams).mockImplementationOnce(fail)
  else if (phase === 'connection') vi.mocked(f.core.commandClient).mockImplementationOnce(fail)
  else f.invoke.mockImplementationOnce(fail)
  const result = request.call(f.core, f.method, f.params).catch(error => error)
  await ready
  f.core.configurationEpochByTarget.set(f.target.id, {})
  release()
  expect(await result).toMatchObject({ code: -32049, data: { kind: 'settings_scope_changed' } })
  expect(f.invoke).toHaveBeenCalledTimes(phase === 'native' ? 1 : 0)
})

test.each(['connection-id', 'disconnect'] as const)('settings results do not survive original %s retirement', async change => {
  const f = fixture('profileRead')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.invoke.mockImplementationOnce(async () => { entered(); await gate; return { profile: 'full', personality: 'friendly' } })
  const result = request.call(f.core, f.method, f.params).catch(error => error)
  await ready
  if (change === 'connection-id') f.client.diagnosticConnection.connectionId = 'replacement'
  else f.core.appServerDisconnectedClients.add(f.client as unknown as GatewayClient)
  release()
  expect(await result).toMatchObject({ code: -32049, data: { kind: 'settings_scope_changed' } })
  expect(f.invoke).toHaveBeenCalledTimes(1)
})

test.each(['settings/templates/list', 'settings/tools/selection/read', 'settings/execution-defaults/read'])('%s aborts before target discovery', async method => {
  const f = fixture('executionRead'), controller = new AbortController()
  controller.abort()
  await expect(request.call(f.core, f.method, { ...f.params, method }, { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(f.core.serverForParams).not.toHaveBeenCalled()
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(['profileRead', 'profileWrite'] as const)('%s cancellation releases only a read wait and preserves accepted write settlement', async operation => {
  const f = fixture(operation), controller = new AbortController()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.invoke.mockImplementationOnce(async () => { entered(); await gate; return { profile: 'full', personality: 'friendly' } })
  let settled = false
  const outcome = request.call(f.core, f.method, f.params, { signal: controller.signal })
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
  await ready
  controller.abort()
  try {
    if (operation === 'profileRead') {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 })
      expect(await outcome).toMatchObject({ error: { name: 'AbortError' } })
    } else {
      await Promise.resolve()
      expect(settled).toBe(false)
    }
  } finally { release(); await outcome }
  if (operation === 'profileWrite') expect(await outcome).toMatchObject({ value: { profile: 'full' } })
  expect(f.invoke).toHaveBeenCalledTimes(1)
  expect(f.client.close).not.toHaveBeenCalled()
})

test('an unrelated target refresh and sidebar scan do not retire the explicit settings owner', async () => {
  const f = fixture('profileRead')
  f.invoke.mockImplementationOnce(async () => {
    f.core.configurationEpochByTarget.set('other-target', {})
    f.core.workspaceScanGeneration++
    return { profile: 'full', personality: 'friendly' }
  })
  await expect(request.call(f.core, f.method, f.params)).resolves.toHaveProperty('profile','full')
  expect(f.invoke).toHaveBeenCalledTimes(1)
})

test('current settings Native failures stay unchanged and are not cached', async () => {
  const f = fixture('executionRead'), failure = new Error('current settings refusal')
  f.invoke.mockRejectedValueOnce(failure)
  await expect(request.call(f.core, f.method, f.params)).rejects.toBe(failure)
  await expect(request.call(f.core, f.method, f.params)).resolves.toBeDefined()
  expect(f.invoke).toHaveBeenCalledTimes(2)
})


test.each(['discovery', 'connection'] as const)('cancelling pending settings %s prevents later dispatch', async phase => {
  const f = fixture('profileRead'), controller = new AbortController()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  if (phase === 'discovery') vi.mocked(f.core.serverForParams).mockImplementationOnce(async () => { entered(); await gate; return f.target })
  else vi.mocked(f.core.commandClient).mockImplementationOnce(async () => { entered(); await gate; return f.client as never })
  const result = request.call(f.core, f.method, f.params, { signal: controller.signal }).catch(error => error)
  await ready
  controller.abort()
  try { expect(await result).toMatchObject({ name: 'AbortError' }) }
  finally { release(); await Promise.resolve() }
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.client.close).not.toHaveBeenCalled()
})

test('one settings reader cancellation leaves another reader and their shared connection alive', async () => {
  const f = fixture('profileRead'), controller = new AbortController()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.invoke.mockImplementation(async () => { await gate; return { profile: 'full', personality: 'friendly' } })
  const cancelled = request.call(f.core, f.method, f.params, { signal: controller.signal }).catch(error => error)
  const peer = request.call(f.core, f.method, f.params)
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2))
  controller.abort()
  try { expect(await cancelled).toMatchObject({ name: 'AbortError' }) }
  finally { release() }
  await expect(peer).resolves.toHaveProperty('profile', 'full')
  expect(f.client.close).not.toHaveBeenCalled()
})

test.each([false, true])('evolution settings use the shared settings entry and reject a stale editor: %s', async stale => {
  const f = fixture('profileRead')
  f.core.assertCommandTarget = vi.fn().mockResolvedValue(undefined)
  const params = { serverId: f.target.id, method: 'settings/evolution/read', params: {},
    targetScope: hookTargetScope(f.target) }
  if (stale) f.target.profile = 'replacement'
  const response = request.call(f.core, 'runtime.settings.request', params)
  if (stale) {
    await expect(response).rejects.toThrow('EVOLUTION_TARGET_CHANGED')
    expect(f.invoke).not.toHaveBeenCalled()
  } else {
    await response
    expect(f.invoke).toHaveBeenCalledWith('settings/evolution/read', {}, undefined)
    expect(f.core.server).not.toHaveBeenCalled()
  }
})
