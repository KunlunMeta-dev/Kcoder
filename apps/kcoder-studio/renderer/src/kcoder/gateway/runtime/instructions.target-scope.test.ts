import { expect, test, vi } from 'vitest'
import { request } from './catalog'
import type { GatewayRuntimeCore } from './core'
import type { GatewayServer } from '../../gatewayRpc'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { KCODER_RUNTIME_METHODS } from '../../legacyRuntimeAbi'

function fixture() {
  const server: GatewayServer = { id: 'instructions-owned', label: 'Owned', transport: 'local', profile: 'original' }
  const invoke = vi.fn(async () => ({ instructions: 'Original', configPath: null }))
  const client = { request: invoke }
  const core = { disposed: false, workspaceScanGeneration: 0, runtimeContextReads: new WeakMap(),
    compatibility: { matchesMethod: (method: string, key: keyof typeof KCODER_RUNTIME_METHODS) => method === KCODER_RUNTIME_METHODS[key] },
    server: vi.fn(async () => server), serverForParams: vi.fn(async () => server),
    commandClient: vi.fn(async () => client), sharedRuntimeContext: vi.fn(async () => invoke()),
  } as unknown as GatewayRuntimeCore
  return { server, core, invoke, params: { deviceId: server.id, targetScope: hookTargetScope(server), instructions: 'Submitted' } }
}

test.each(['instructionsRead', 'instructionsWrite'] as const)('an old %s editor cannot use replacement profile facts', async operation => {
  const f = fixture()
  f.server.profile = 'replacement'
  await expect(request.call(f.core, KCODER_RUNTIME_METHODS[operation], f.params)).rejects.toMatchObject({ code: -32049, data: { kind: 'instructions_scope_changed' } })
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(['discovery', 'client'] as const)('configuration retirement during %s stops a pending instruction write', async phase => {
  const f = fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  if (phase === 'discovery') vi.mocked(f.core.serverForParams).mockImplementationOnce(async () => { entered(); await gate; return f.server })
  else vi.mocked(f.core.commandClient).mockImplementationOnce(async () => { entered(); await gate; return { request: f.invoke } as never })
  const pending = request.call(f.core, KCODER_RUNTIME_METHODS.instructionsWrite, f.params)
  const result = pending.catch(error => error)
  await ready
  f.core.workspaceScanGeneration++
  release()
  expect(await result).toBeInstanceOf(Error)
  expect(f.invoke).not.toHaveBeenCalled()
})

test.each(['instructionsRead', 'instructionsWrite'] as const)('late %s results are retired without replaying a completed operation', async operation => {
  const f = fixture()
  let finish!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.invoke.mockImplementationOnce(async () => { entered(); await gate; return { instructions: 'Original', configPath: null } })
  const result = request.call(f.core, KCODER_RUNTIME_METHODS[operation], f.params).catch(error => error)
  await ready
  f.core.workspaceScanGeneration++
  finish()
  expect(await result).toBeInstanceOf(Error)
  expect(f.invoke).toHaveBeenCalledTimes(1)
  expect(f.core.server).not.toHaveBeenCalled()
})

test.each(['instructionsRead', 'instructionsWrite'] as const)('%s retains legacy callers without a narrowing UI scope', async operation => {
  const f = fixture()
  await expect(request.call(f.core, KCODER_RUNTIME_METHODS[operation], { deviceId: f.server.id, instructions: 'Submitted' }))
    .resolves.toMatchObject({ instructions: 'Original' })
  expect(f.invoke).toHaveBeenCalledTimes(1)
  expect(f.core.server).not.toHaveBeenCalled()
})
