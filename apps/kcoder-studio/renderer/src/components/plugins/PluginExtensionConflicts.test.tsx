import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { ExtensionsRequestError, type ExtensionsApi } from '@/kcoder/extensionsInventory'
import { previewSummaryText } from '@/kcoder/extensionsLabels'
import { PluginExtensionConflicts, PluginInstallOverlapNotice } from './PluginExtensionConflicts'

const larkPreview = {
  entries: Array.from({ length: 28 }, (_, index) =>
    index < 25
      ? {
          kind: 'skill' as const,
          name: `lark-${index}`,
          outcome: 'shadowed_by_existing' as const,
          existing: { layer: 'bundled' as const, path: `~/.kcoder/skills/.builtin/lark-${index}` },
          sameUpstream: true,
        }
      : { kind: 'skill' as const, name: `trae-${index}`, outcome: 'none' as const }
  ),
  conflicts: [],
}

function api(): ExtensionsApi & { previewConflicts: ReturnType<typeof vi.fn> } {
  return {
    inventory: vi.fn(),
    updateSkillPreference: vi.fn(),
    previewConflicts: vi.fn(),
    setPluginSkillsEnabled: vi.fn(),
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

test('summarizes the lark overlap before and after installation', () => {
  const t = i18n.getFixedT('en', 'extensions')
  expect(previewSummaryText(t, larkPreview, false)).toBe(
    'Installs 28 skills; 25 will be overridden by built-in lark-* (same upstream)'
  )
  const zh = i18n.getFixedT('zh-CN', 'extensions')
  expect(previewSummaryText(zh, larkPreview, true)).toBe(
    '提供 28 个技能；其中 25 个会被内置 lark-* 覆盖（同一上游）'
  )
  expect(
    previewSummaryText(t, { entries: larkPreview.entries.slice(25), conflicts: [] }, false)
  ).toBeNull()
})

test('previews declared names of a marketplace plugin that is not installed', async () => {
  const client = api()
  client.previewConflicts.mockResolvedValue(larkPreview)
  render(
    <PluginExtensionConflicts
      api={client}
      pluginId="lark@trae"
      manifest={{ skills: ['./skills/lark-doc', './skills/lark-im'] }}
      installed={false}
    />
  )
  expect(await screen.findByTestId('plugin-extension-conflicts-summary')).toHaveTextContent(
    'Installs 28 skills'
  )
  expect(client.previewConflicts).toHaveBeenCalledExactlyOnceWith({
    pluginId: 'lark@trae',
    skillNames: ['lark-doc', 'lark-im'],
    mcpServerNames: [],
  })
  expect(screen.getByText(/declared by the marketplace entry/)).toBeInTheDocument()
})

test('older targets and undeclared marketplace entries show nothing', async () => {
  const client = api()
  client.previewConflicts.mockRejectedValue(new ExtensionsRequestError('unsupported', 'old'))
  const view = render(
    <PluginExtensionConflicts api={client} pluginId="lark@trae" installed manifest={{}} />
  )
  await waitFor(() =>
    expect(client.previewConflicts).toHaveBeenCalledWith({ pluginId: 'lark@trae' })
  )
  await waitFor(() => expect(view.container).toBeEmptyDOMElement())
  view.rerender(
    <PluginExtensionConflicts api={client} pluginId="x@y" installed={false} manifest={{}} />
  )
  expect(view.container).toBeEmptyDOMElement()
  expect(client.previewConflicts).toHaveBeenCalledTimes(1)
})

test('an install result is shown without another preview request', () => {
  const client = api()
  render(
    <>
      <PluginExtensionConflicts api={client} pluginId="lark@trae" installed result={larkPreview} />
      <PluginInstallOverlapNotice name="Lark" result={larkPreview} onDismiss={() => undefined} />
    </>
  )
  expect(screen.getAllByTestId('plugin-extension-conflicts-summary')[0]).toHaveTextContent(
    'Provides 28 skills; 25 will be overridden by built-in lark-*'
  )
  expect(screen.getByTestId('plugin-install-overlap')).toHaveTextContent('Lark installed.')
  expect(client.previewConflicts).not.toHaveBeenCalled()
})
