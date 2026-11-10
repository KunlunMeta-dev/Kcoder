import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { fetchGatewayServers } from './gatewayRpc'
import { hookTargetScope } from './gatewayHookConfiguration'
import {
  changedToolSelection,
  clearToolSelectionProjections,
  readToolSelections,
  saveToolSelections,
  syncLocalToolSelectionProjection,
  toolSelectionProjection,
} from './toolSelections'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('./gatewayRpc', () => ({ fetchGatewayServers: vi.fn(), isKCoderGatewayPage: () => true }))
const local = { id: 'local', transport: 'local' as const }
const remote = { id: 'remote', transport: 'ssh' as const }
const response = { revision: 'one', modes: [], tools: [], total: 0, truncated: false }
beforeEach(() => {
  vi.clearAllMocks()
  clearToolSelectionProjections()
  vi.mocked(fetchGatewayServers).mockResolvedValue([remote, local])
  vi.mocked(requestLocalExecutor).mockResolvedValue(response)
})
test('startup reads only the local host and projects the scoped result without writes or sessions', async () => {
  await syncLocalToolSelectionProjection(() => true)
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.settings.request', {
    serverId: 'local',
    method: 'settings/tools/selection/read',
    params: {},
  })
  expect(toolSelectionProjection(hookTargetScope(local))).toEqual(response)
})
test('startup does not fall back to SSH or publish invalidated account results', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValueOnce([remote])
  await syncLocalToolSelectionProjection(() => true)
  expect(requestLocalExecutor).not.toHaveBeenCalled()
  let current = true
  vi.mocked(requestLocalExecutor).mockImplementationOnce(async () => {
    current = false
    return response
  })
  await syncLocalToolSelectionProjection(() => current)
  expect(toolSelectionProjection(hookTargetScope(local))).toBeUndefined()
})
test('startup failure is silent and ordinary RPC adapters preserve mode and revision', async () => {
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(new Error('unsupported'))
  await expect(syncLocalToolSelectionProjection(() => true)).resolves.toBeUndefined()
  await readToolSelections('remote')
  await saveToolSelections('remote', 'kworker', ['Read'], 'old')
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    method: 'settings/tools/selection/save',
    params: { mode: 'kworker', allowedTools: ['Read'], expectedRevision: 'old' },
  })
  expect(changedToolSelection(['Invisible', 'Read'], 'Read', false)).toEqual(['Invisible'])
})

test('rejects invalid settings responses and silently discards invalid startup projections', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue({ revision: 'invalid', tools: [] })
  await expect(readToolSelections('local')).rejects.toThrow('Invalid tool selections response')
  await expect(saveToolSelections('local', 'kcoder', [], 'old')).rejects.toThrow(
    'Invalid tool selections response'
  )
  await expect(syncLocalToolSelectionProjection(() => true)).resolves.toBeUndefined()
  expect(toolSelectionProjection(hookTargetScope(local))).toBeUndefined()
})

test('expert tool catalog reads retain the explicitly selected project', async () => {
  await readToolSelections('remote', '/original-project')
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
    expect(await readToolSelections('remote', '/original-project')).toEqual(result)
  }
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ ...response, lunaAllowedTools: 'read' })
  await expect(readToolSelections('remote')).rejects.toThrow('Invalid tool selections response')
})

test('expert editors explicitly request the negotiated Luna baseline', async () => {
  await readToolSelections('remote', '/original-project', true)
  expect(requestLocalExecutor).toHaveBeenLastCalledWith('runtime.settings.request', {
    serverId: 'remote',
    workspacePath: '/original-project',
    method: 'settings/tools/selection/read',
    params: { includeLunaBaseline: true },
  })
})

test('requests a pure resolution preview without selecting or starting a task', async () => {
  await readToolSelections('remote', '/project', true, null)
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
