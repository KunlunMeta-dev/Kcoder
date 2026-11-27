import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  ExtensionsRequestError,
  type ExtensionsApi,
  type ExtensionsInventoryResult,
} from './extensionsInventory'
import { binaryInventory, larkInventory } from './extensionsInventory.test-fixtures'
import { useExtensionsInventory } from './useExtensionsInventory'
import {
  ExtensionsAllView,
  ExtensionsConflictsView,
  SkillOverrideBadges,
} from './KCoderExtensionsView'
import { sourceLabel } from './extensionsLabels'

function mockApi(initial: ExtensionsInventoryResult = larkInventory()) {
  return {
    inventory: vi.fn(async (options?: { includeBinaries?: boolean }) =>
      options?.includeBinaries ? binaryInventory() : initial
    ),
    updateSkillPreference: vi.fn(),
    previewConflicts: vi.fn(),
    setPluginSkillsEnabled: vi.fn(),
  } satisfies ExtensionsApi
}

function Harness({ api, view }: { api: ExtensionsApi; view: 'all' | 'conflicts' }) {
  const state = useExtensionsInventory({ enabled: true, deviceId: 'local' }, api)
  return (
    <>
      <button type="button" onClick={() => void state.refresh()}>
        poll
      </button>
      {view === 'all' ? (
        <ExtensionsAllView state={state} query="" onShowConflicts={() => undefined} />
      ) : (
        <ExtensionsConflictsView state={state} query="" />
      )}
      <SkillOverrideBadges result={state.result} name="lark-doc" />
    </>
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

test('lists every copy with its source layer and override relation', async () => {
  render(<Harness api={mockApi()} view="all" />)
  const rows = await screen.findAllByTestId('extensions-item')
  const pluginCopy = rows.find(row => row.dataset.itemId === 'skill:plugin:lark@trae:lark-doc')!
  expect(within(pluginCopy).getByTestId('extensions-item-source')).toHaveTextContent('Plugin Lark')
  expect(within(pluginCopy).getByTestId('extensions-item-state')).toHaveTextContent('Overridden')
  expect(within(pluginCopy).getByTestId('extensions-shadowed-by')).toHaveTextContent(
    'Overridden by Bundled'
  )
  const bundled = rows.find(row => row.dataset.itemId === 'skill:bundled::lark-doc')!
  expect(within(bundled).getByTestId('extensions-shadows')).toHaveTextContent(
    'Overrides Plugin Lark'
  )
  expect(screen.getByTestId('extensions-applies')).toHaveTextContent('new conversations')
  expect(screen.getByTestId('kcoder-skill-override-badges')).toHaveTextContent(
    'Overrides the Plugin Lark copy'
  )
  // Details stay behind disclosure but carry path and upstream.
  expect(within(pluginCopy).getByText('v1.0.8')).not.toBeVisible()
  fireEvent.change(screen.getByTestId('extensions-kind-filter'), { target: { value: 'hook' } })
  expect(screen.getAllByTestId('extensions-item').map(row => row.dataset.kind)).toEqual(['hook'])
})

test('layer labels are localized for every source', () => {
  const t = i18n.getFixedT('zh-CN', 'extensions')
  const plugins = new Map([['lark@trae', 'Lark']])
  expect(
    (['builtin', 'bundled', 'project', 'external', 'user', 'runtime'] as const).map(layer =>
      sourceLabel(t, { layer }, plugins)
    )
  ).toEqual(['内置', '随包', '项目', '外部目录', '用户', '运行时'])
  expect(sourceLabel(t, { layer: 'plugin', ownerPluginId: 'lark@trae' }, plugins)).toBe('插件 Lark')
})

test('selecting the plugin copy writes the observed revision and refreshes without probes', async () => {
  const api = mockApi()
  api.updateSkillPreference.mockResolvedValue({
    preference: { preferPluginSkills: { 'lark-doc': 'lark@trae' }, preferPlugins: [] },
    revision: 'rev-2',
    appliesToNewConversations: true,
  })
  render(<Harness api={api} view="all" />)
  fireEvent.click(await screen.findByTestId('extensions-action-use-plugin'))
  await waitFor(() =>
    expect(screen.getByTestId('extensions-notice')).toHaveTextContent(
      'Applies to new conversations'
    )
  )
  expect(api.updateSkillPreference).toHaveBeenCalledExactlyOnceWith('rev-1', {
    preferPluginSkills: { 'lark-doc': 'lark@trae' },
    preferPlugins: [],
  })
  await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(2))
  expect(api.inventory.mock.calls.every(([options]) => !options?.includeBinaries)).toBe(true)
})

test('a stale revision reloads authoritative state and never retries the write', async () => {
  const api = mockApi()
  api.updateSkillPreference.mockRejectedValue(
    new ExtensionsRequestError('preference_conflict', 'changed')
  )
  render(<Harness api={api} view="all" />)
  fireEvent.click(await screen.findByTestId('extensions-action-use-plugin'))
  const notice = await screen.findByTestId('extensions-notice')
  expect(notice).toHaveAttribute('role', 'alert')
  expect(notice).toHaveTextContent('changed elsewhere')
  await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(2))
  expect(api.updateSkillPreference).toHaveBeenCalledTimes(1)
})

test('only the explicit check probes binaries and its result survives later polling', async () => {
  const api = mockApi()
  render(<Harness api={api} view="all" />)
  await screen.findAllByTestId('extensions-item')
  fireEvent.click(screen.getByText('poll'))
  await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('lark-cli')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('extensions-check-binaries'))
  await waitFor(() => expect(screen.getAllByText('lark-cli')).toHaveLength(2))
  fireEvent.click(screen.getByText('poll'))
  await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(4))
  expect(screen.getAllByText('lark-cli')).toHaveLength(2)
  expect(screen.getByTestId('extensions-binary-findings')).toHaveTextContent(
    'lark-cli 1.0.8 on PATH differs from the bundled 1.0.100'
  )
  expect(api.inventory.mock.calls.map(([options]) => options ?? {})).toEqual([
    {},
    {},
    { includeBinaries: true },
    {},
  ])
})

test('conflicts summarize the overlap with expandable sources, hooks and family actions', async () => {
  const api = mockApi(binaryInventory())
  api.updateSkillPreference.mockResolvedValue({
    preference: { preferPluginSkills: {}, preferPlugins: ['lark@trae'] },
    revision: 'rev-2',
    appliesToNewConversations: true,
  })
  render(<Harness api={api} view="conflicts" />)
  const conflicts = await screen.findAllByTestId('extensions-conflict')
  const sameName = conflicts.find(row => row.dataset.reason === 'same_name')!
  expect(sameName).toHaveTextContent('lark-doc: Bundled is in use; 1 other copy is overridden.')
  expect(within(sameName).getByTestId('extensions-same-upstream')).toBeInTheDocument()
  expect(within(sameName).getAllByText('https://github.com/larksuite/cli')).toHaveLength(2)
  const binaries = conflicts.find(row => row.dataset.reason === 'version_mismatch')!
  expect(binaries).toHaveTextContent('lark-cli 1.0.8 on PATH differs from the bundled 1.0.100')
  expect(conflicts.find(row => row.dataset.reason === 'multiple_binaries')).toHaveTextContent(
    '/usr/local/bin/lark-cli is used'
  )
  const issue = screen.getByTestId('extensions-hook-issue')
  expect(issue).toHaveAttribute('data-severity', 'error')
  expect(issue).toHaveTextContent('hooks.PreToolUse[1].hooks[0]')
  const family = conflicts.find(row => row.dataset.reason === 'mixed_family')!
  await act(async () => {
    fireEvent.click(within(family).getByTestId('extensions-action-prefer'))
  })
  expect(api.updateSkillPreference).toHaveBeenCalledExactlyOnceWith('rev-1', {
    preferPluginSkills: {},
    preferPlugins: ['lark@trae'],
  })
})

test('an effective per-name plugin copy offers the built-in version again', async () => {
  const inventory = larkInventory({
    skillPreference: { preferPluginSkills: { 'lark-doc': 'lark@trae' }, preferPlugins: [] },
  })
  inventory.items = inventory.items.map(item =>
    item.name !== 'lark-doc'
      ? item
      : item.layer === 'plugin'
        ? {
            ...item,
            effective: true,
            preferred: true,
            shadowedBy: null,
            shadows: [{ layer: 'bundled' }],
          }
        : {
            ...item,
            effective: false,
            shadows: [],
            shadowedBy: { layer: 'plugin', ownerPluginId: 'lark@trae' },
          }
  )
  const api = mockApi(inventory)
  api.updateSkillPreference.mockResolvedValue({
    preference: {},
    revision: 'rev-2',
    appliesToNewConversations: true,
  })
  render(<Harness api={api} view="all" />)
  expect(await screen.findByTestId('kcoder-skill-override-badges')).toHaveTextContent(
    'Plugin version selected'
  )
  expect(screen.getByTestId('extensions-action-use-default')).toHaveTextContent(
    'Use built-in version'
  )
  fireEvent.click(screen.getByTestId('extensions-action-use-default'))
  await waitFor(() =>
    expect(api.updateSkillPreference).toHaveBeenCalledExactlyOnceWith('rev-1', {
      preferPluginSkills: {},
      preferPlugins: [],
    })
  )
})

/** A target with `pluginSkillPolicyV1`: the installed Lark plugin reports its skill switch. */
function switchableInventory(skillsEnabled: boolean, revision: string): ExtensionsInventoryResult {
  const inventory = larkInventory({ pluginSkillPolicy: true })
  inventory.items = inventory.items.map(item =>
    item.kind === 'plugin' ? { ...item, skillsEnabled, skillPolicyRevision: revision } : item
  )
  return inventory
}

test('targets without the skill switch keep the whole-plugin explanation', async () => {
  render(<Harness api={mockApi()} view="all" />)
  const rows = await screen.findAllByTestId('extensions-item')
  const plugin = rows.find(row => row.dataset.kind === 'plugin')!
  expect(within(plugin).queryByTestId('extensions-plugin-skills-switch')).not.toBeInTheDocument()
  expect(plugin).toHaveTextContent('Upgrade KCoder on the target to turn off only the skills')
})

test('the plugin row switch writes the observed revision and reloads the target state', async () => {
  const api = mockApi(switchableInventory(true, 'skill-rev-1'))
  api.setPluginSkillsEnabled.mockImplementation(async () => {
    api.inventory.mockResolvedValue(switchableInventory(false, 'skill-rev-2'))
    return {
      pluginId: 'lark@trae',
      skillsEnabled: false,
      revision: 'skill-rev-2',
      changed: true,
      generation: 2,
      appliesToNewConversations: true,
    }
  })
  render(<Harness api={api} view="all" />)
  const rows = await screen.findAllByTestId('extensions-item')
  const plugin = rows.find(row => row.dataset.kind === 'plugin')!
  const toggle = within(plugin).getByTestId('extensions-plugin-skills-switch')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).toHaveAccessibleName('Enable the skills of Lark')
  expect(plugin).not.toHaveTextContent('Upgrade KCoder')
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(screen.getByTestId('extensions-notice')).toHaveTextContent(
      'Applies to new conversations'
    )
  )
  expect(api.setPluginSkillsEnabled).toHaveBeenCalledExactlyOnceWith(
    'lark@trae',
    false,
    'skill-rev-1'
  )
  await waitFor(() =>
    expect(screen.getByTestId('extensions-plugin-skills-switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  )
  expect(api.inventory.mock.calls.every(([options]) => !options?.includeBinaries)).toBe(true)
  // The existing preference actions stay available next to the switch.
  expect(screen.getByTestId('extensions-action-use-plugin')).toBeInTheDocument()
})

test('conflict details offer the owning plugin switch; a stale revision is not replayed', async () => {
  const api = mockApi(switchableInventory(true, 'skill-rev-1'))
  api.setPluginSkillsEnabled.mockRejectedValue(
    new ExtensionsRequestError('skill_switch_conflict', 'changed')
  )
  render(<Harness api={api} view="conflicts" />)
  const conflicts = await screen.findAllByTestId('extensions-conflict')
  const sameName = conflicts.find(row => row.dataset.reason === 'same_name')!
  const control = within(sameName).getByTestId('extensions-plugin-skills')
  expect(control).toHaveAttribute('data-plugin-id', 'lark@trae')
  expect(control).toHaveTextContent("Enable this plugin's skills")
  fireEvent.click(within(control).getByTestId('extensions-plugin-skills-switch'))
  const notice = await screen.findByTestId('extensions-notice')
  expect(notice).toHaveAttribute('data-kind', 'skill_switch_conflict')
  expect(notice).toHaveTextContent("This plugin's skill setting was changed elsewhere")
  await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(2))
  expect(api.setPluginSkillsEnabled).toHaveBeenCalledTimes(1)
})

test('switch copy is localized in Chinese', async () => {
  await i18n.changeLanguage('zh-CN')
  render(<Harness api={mockApi(switchableInventory(false, 'skill-rev-1'))} view="all" />)
  const control = await screen.findByTestId('extensions-plugin-skills')
  expect(control).toHaveTextContent('启用此插件的技能')
  expect(control).toHaveTextContent('此插件的技能已关闭')
})


test('saved skill preference invalidates only its original target presentation', async () => {
  const api = mockApi()
  api.updateSkillPreference.mockResolvedValue({
    preference: { preferPluginSkills: {}, preferPlugins: [] }, revision: 'rev-2', appliesToNewConversations: true,
  })
  const changed = vi.fn()
  window.addEventListener('kcoder:tools-catalog-invalidated', changed)
  const hook = renderHook(() => useExtensionsInventory({ enabled: true, deviceId: 'skills-target' }, api))
  try {
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    await act(async () => { await hook.result.current.updatePreference({ preferPluginSkills: {}, preferPlugins: [] }) })
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: { deviceId: 'skills-target' } }))
  } finally { hook.unmount(); window.removeEventListener('kcoder:tools-catalog-invalidated', changed) }
})
