import { afterEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { GatewayRpcError, GatewayRpcTimeoutError } from './gatewayRpc'
import {
  createExtensionsApi,
  declaredPluginNames,
  extensionsFailureKind,
  mergeBinaryResult,
  pluginPreferenceSource,
  pluginSkillSwitch,
  preferPluginCopy,
  preferenceCanSelect,
  restoreDefaultCopy,
  setPluginPreferred,
  summarizePreview,
} from './extensionsInventory'
import { binaryInventory, larkInventory } from './extensionsInventory.test-fixtures'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))

afterEach(() => vi.resetAllMocks())

test('inventory requests never probe binaries unless explicitly asked', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValue(larkInventory())
  const api = createExtensionsApi({ deviceId: 'local', workspacePath: '/work' })
  await api.inventory()
  await api.inventory({ includeBinaries: false })
  await api.inventory({ includeBinaries: true })
  expect(vi.mocked(requestLocalExecutor).mock.calls.map(([, value]) => value)).toEqual([
    { deviceId: 'local', workspacePath: '/work', method: 'extensions/inventory', params: {} },
    { deviceId: 'local', workspacePath: '/work', method: 'extensions/inventory', params: {} },
    {
      deviceId: 'local',
      workspacePath: '/work',
      method: 'extensions/inventory',
      params: { includeBinaries: true },
    },
  ])
})

test('the fixtures satisfy the generated contract and malformed replies are rejected', async () => {
  vi.mocked(requestLocalExecutor)
    .mockResolvedValueOnce(binaryInventory())
    .mockResolvedValueOnce({ servers: [] })
  const api = createExtensionsApi()
  await expect(api.inventory()).resolves.toMatchObject({ binariesIncluded: true })
  await expect(api.inventory()).rejects.toMatchObject({ kind: 'unavailable' })
})

test('failures are classified without trusting remote text', async () => {
  const api = createExtensionsApi({ deviceId: 'old' })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcError('upgrade', -32000, { kind: 'plugin_update_required' })
  )
  await expect(api.inventory()).rejects.toMatchObject({ kind: 'unsupported' })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcError('changed', -32049, { kind: 'skill_preference_conflict' })
  )
  await expect(api.updateSkillPreference('rev-0', {})).rejects.toMatchObject({
    kind: 'preference_conflict',
  })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcError('bad', -32602, { kind: 'extensions_invalid' })
  )
  await expect(api.updateSkillPreference('rev-0', {})).rejects.toMatchObject({ kind: 'invalid' })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcTimeoutError('extensions/skillPreference/update', 30_000, 'old')
  )
  await expect(api.updateSkillPreference('rev-0', {})).rejects.toMatchObject({
    kind: 'unconfirmed',
  })
  expect(extensionsFailureKind(new GatewayRpcTimeoutError('extensions/inventory', 1, 'old'))).toBe(
    'unavailable'
  )
})

test('preference writes send the whole object with the observed revision', async () => {
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce({
    preference: { preferPluginSkills: { 'lark-doc': 'lark@trae' }, preferPlugins: [] },
    revision: 'rev-2',
    appliesToNewConversations: true,
  })
  const api = createExtensionsApi({ deviceId: 'local' })
  const receipt = await api.updateSkillPreference(
    'rev-1',
    preferPluginCopy({}, 'lark-doc', 'lark@trae')
  )
  expect(receipt.revision).toBe('rev-2')
  expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('runtime.plugins.request', {
    deviceId: 'local',
    method: 'extensions/skillPreference/update',
    params: {
      expectedRevision: 'rev-1',
      preference: { preferPluginSkills: { 'lark-doc': 'lark@trae' }, preferPlugins: [] },
    },
  })
})

test('a changed scope rejects before sending and ignores late replies', async () => {
  let current = true
  const api = createExtensionsApi({ deviceId: 'a', isScopeCurrent: () => current })
  vi.mocked(requestLocalExecutor).mockImplementationOnce(async () => {
    current = false
    return larkInventory()
  })
  await expect(api.inventory()).rejects.toMatchObject({ kind: 'scope_changed' })
  await expect(api.updateSkillPreference('rev-1', {})).rejects.toMatchObject({
    kind: 'scope_changed',
  })
  expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
})

test('preference transforms follow the documented precedence', () => {
  const byName = preferPluginCopy({ preferPlugins: ['other@x'] }, 'lark-doc', 'lark@trae')
  expect(byName).toEqual({
    preferPluginSkills: { 'lark-doc': 'lark@trae' },
    preferPlugins: ['other@x'],
  })
  expect(pluginPreferenceSource(byName, 'lark-doc', 'lark@trae')).toBe('name')
  expect(restoreDefaultCopy(byName, 'lark-doc', 'lark@trae')).toEqual({
    preferPluginSkills: {},
    preferPlugins: ['other@x'],
  })
  const byPlugin = setPluginPreferred({}, 'lark@trae', true)
  expect(pluginPreferenceSource(byPlugin, 'lark-doc', 'lark@trae')).toBe('plugin')
  // A per-plugin preference cannot be narrowed to one name.
  expect(restoreDefaultCopy(byPlugin, 'lark-doc', 'lark@trae')).toBeNull()
  expect(setPluginPreferred(byPlugin, 'lark@trae', false).preferPlugins).toEqual([])
  // A name pointing at another plugin overrides the per-plugin entry.
  expect(
    pluginPreferenceSource(
      { preferPluginSkills: { 'lark-doc': 'other@x' }, preferPlugins: ['lark@trae'] },
      'lark-doc',
      'lark@trae'
    )
  ).toBeNull()
  expect(preferenceCanSelect('bundled')).toBe(true)
  expect(preferenceCanSelect('project')).toBe(false)
  expect(preferenceCanSelect('user')).toBe(false)
})

test('binary rows from an explicit check survive later refreshes without probes', () => {
  const merged = mergeBinaryResult(
    larkInventory({ skillPreferenceRevision: 'rev-2' }),
    binaryInventory()
  )
  expect(merged.binariesIncluded).toBe(true)
  expect(merged.skillPreferenceRevision).toBe('rev-2')
  expect(merged.items.filter(item => item.kind === 'binary')).toHaveLength(2)
  expect(merged.conflicts.map(conflict => conflict.reason)).toContain('version_mismatch')
  expect(mergeBinaryResult(larkInventory(), null).binariesIncluded).toBe(false)
})

test('preview summaries group families and declared names come only from the manifest', () => {
  const entries = Array.from({ length: 28 }, (_, index) => ({
    kind: 'skill' as const,
    name: index < 25 ? `lark-${index}` : `trae-${index}`,
    outcome: index < 25 ? ('shadowed_by_existing' as const) : ('none' as const),
    existing: index < 25 ? { layer: 'bundled' as const } : null,
    sameUpstream: index < 25,
  }))
  expect(summarizePreview({ entries, conflicts: [] })).toMatchObject({
    skills: 28,
    shadowed: 25,
    sameUpstream: 25,
    shadowedBy: ['lark-*'],
  })
  expect(
    declaredPluginNames({
      skills: ['./skills/lark-doc', 'skills/lark-im/SKILL.md', '..', 3],
      mcpServers: { lark: {} },
    })
  ).toEqual({ skillNames: ['lark-doc', 'lark-im'], mcpServerNames: ['lark'] })
  expect(declaredPluginNames(undefined)).toEqual({ skillNames: [], mcpServerNames: [] })
})

test('the plugin skill switch sends the observed revision and rejects mismatched receipts', async () => {
  const api = createExtensionsApi({ deviceId: 'local' })
  const receipt = {
    pluginId: 'lark@trae',
    skillsEnabled: false,
    revision: 'b'.repeat(64),
    changed: true,
    generation: 3,
    appliesToNewConversations: true,
  }
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce(receipt)
  await expect(api.setPluginSkillsEnabled('lark@trae', false, 'a'.repeat(64))).resolves.toEqual(
    receipt
  )
  expect(vi.mocked(requestLocalExecutor).mock.calls[0][1]).toEqual({
    deviceId: 'local',
    method: 'plugin/skills/setEnabled',
    params: { pluginId: 'lark@trae', enabled: false, expectedRevision: 'a'.repeat(64) },
  })
  vi.mocked(requestLocalExecutor).mockResolvedValueOnce({ ...receipt, pluginId: 'other@trae' })
  await expect(
    api.setPluginSkillsEnabled('lark@trae', false, 'a'.repeat(64))
  ).rejects.toMatchObject({ kind: 'unavailable' })
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcError('changed', -32049, { kind: 'plugin_skill_policy_conflict' })
  )
  await expect(api.setPluginSkillsEnabled('lark@trae', true, 'a'.repeat(64))).rejects.toMatchObject(
    { kind: 'skill_switch_conflict' }
  )
  vi.mocked(requestLocalExecutor).mockRejectedValueOnce(
    new GatewayRpcError('upgrade', -32000, { kind: 'plugin_update_required' })
  )
  await expect(api.setPluginSkillsEnabled('lark@trae', true, 'a'.repeat(64))).rejects.toMatchObject(
    { kind: 'unsupported' }
  )
})

test('the switch is offered only by targets that report the policy for that plugin', () => {
  const withSwitch = larkInventory({ pluginSkillPolicy: true })
  expect(pluginSkillSwitch(withSwitch, 'lark@trae')).toBeNull()
  withSwitch.items = withSwitch.items.map(item =>
    item.kind === 'plugin' ? { ...item, skillsEnabled: false, skillPolicyRevision: 'rev' } : item
  )
  expect(pluginSkillSwitch(withSwitch, 'lark@trae')).toEqual({ enabled: false, revision: 'rev' })
  expect(pluginSkillSwitch({ ...withSwitch, pluginSkillPolicy: false }, 'lark@trae')).toBeNull()
  expect(pluginSkillSwitch(withSwitch, 'other@trae')).toBeNull()
})
