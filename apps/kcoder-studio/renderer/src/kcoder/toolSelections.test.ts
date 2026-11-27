import { beforeEach, expect, test, vi } from 'vitest'
import { requestTargetSettings } from './gateway/runtime/targetSettings'
import { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayServer } from './gatewayRpc'
import { hookTargetScope } from './gatewayHookConfiguration'
import { requestLocalExecutor } from '@/host/localExecutor'
import {
  changedToolSelection,
  readToolSelections,
  saveToolSelections,
} from './toolSelections'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const response = { revision: 'one', modes: [], tools: [], total: 0, truncated: false }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requestLocalExecutor).mockResolvedValue(response)
})
test('ordinary RPC adapters preserve mode and revision', async () => {
  await readToolSelections('remote')
  await saveToolSelections('remote', 'kworker', ['Read'], 'old')
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    method: 'settings/tools/selection/save',
    params: { mode: 'kworker', allowedTools: ['Read'], expectedRevision: 'old' },
  })
  expect(changedToolSelection(['Invisible', 'Read'], 'Read', false)).toEqual(['Invisible'])
})

test('rejects invalid settings responses', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ revision: 'invalid', tools: [] })
  await expect(readToolSelections('local')).rejects.toThrow('Invalid tool selections response')
  await expect(saveToolSelections('local', 'kcoder', [], 'old')).rejects.toThrow(
    'Invalid tool selections response'
  )
})

test('each editor read obtains the current target revision without a completed result cache', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce(response)
    .mockResolvedValueOnce({ ...response, revision: 'two' })
  expect((await readToolSelections('local')).revision).toBe('one')
  expect((await readToolSelections('local')).revision).toBe('two')
  expect(requestLocalExecutor).toHaveBeenCalledTimes(2)
})

test('expert tool catalog reads retain the explicitly selected project', async () => {
  await readToolSelections('remote', { workspacePath: '/original-project' })
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    workspacePath: '/original-project',
    method: 'settings/tools/selection/read',
    params: {},
  })
})

test('preserves distinct target Luna defaults, including empty and legacy missing baselines', async () => {
  for (const lunaAllowedTools of [['read', 'HiddenTool'], [], undefined]) {
    const result = { ...response, ...(lunaAllowedTools ? { lunaAllowedTools } : {}) }
    vi.mocked(requestLocalExecutor).mockResolvedValueOnce(result)
    expect(await readToolSelections('remote', { workspacePath: '/original-project' })).toEqual(result)
  }
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ ...response, lunaAllowedTools: 'read' })
  await expect(readToolSelections('remote')).rejects.toThrow('Invalid tool selections response')
})

test('expert editors explicitly request the negotiated Luna baseline', async () => {
  await readToolSelections('remote', { workspacePath: '/original-project', includeLunaBaseline: true })
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    workspacePath: '/original-project',
    method: 'settings/tools/selection/read',
    params: { includeLunaBaseline: true },
  })
})

test('requests a pure resolution preview without selecting or starting a task', async () => {
  await readToolSelections('remote', { workspacePath: '/project', includeLunaBaseline: true, previewExpert: null })
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    workspacePath: '/project',
    method: 'settings/tools/selection/read',
    params: {
      includeLunaBaseline: true,
      includeResolution: true,
      includeExpertToolSelection: true,
    },
  })
})

test.each(['read', 'save'] as const)('%s cannot dispatch an old editor through a replacement same-ID profile', async operation => {
  const target: GatewayServer = { id: 'remote', transport: 'local', profile: 'original' }
  const expected = { targetScope: hookTargetScope(target) }
  target.profile = 'replacement'
  const invoke = vi.fn(async () => response)
  const core = { disposed: false, workspaceScanGeneration: 0,
    accountEpochByTarget: new Map(), configurationEpochByTarget: new Map(), commandDirectoryRefresh: new Map(),
    serverForParams: vi.fn(async () => target),
    commandClient: vi.fn(async () => ({ request: invoke, supportsExperimental: () => true })),
  } as unknown as GatewayRuntimeCore
  core.captureReadSource = targetId => GatewayRuntimeCore.prototype.captureReadSource.call(core, targetId)
  vi.mocked(requestLocalExecutor).mockImplementation((_method, params) => requestTargetSettings.call(core, params))
  const pending = operation === 'read' ? readToolSelections('remote', expected)
    : saveToolSelections('remote', 'kcoder', ['Read'], 'one', expected)
  await expect(pending).rejects.toMatchObject({ code: -32049 })
  expect(invoke).not.toHaveBeenCalled()
})
