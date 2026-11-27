import i18n from './index'
import { expect, test } from 'vitest'
import en from './locales/en/common'
import zh from './locales/zh-CN/common'

const englishNamespaces = import.meta.glob('./locales/en/*.json', {
  eager: true,
  import: 'default',
})
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
test('English UI resources contain no Chinese fallback text', () => {
  for (const [namespace, value] of Object.entries(englishNamespaces)) {
    expect(
      strings(value).filter(text => /[\u3400-\u9fff]/u.test(text)),
      namespace
    ).toEqual([])
  }
})
test('settings navigation and file actions have labels in the namespace used by the UI', () => {
  for (const key of [
    'settings_nav_kcoder_servers',
    'settings_nav_storage',
    'workspace_file_create_file',
    'workspace_file_delete',
    'plugins_marketplace_manage',
    'shorten_wait',
  ] as const) {
    expect(en.workbench[key]).not.toMatch(/[\u3400-\u9fff]/u)
    expect(zh.workbench[key]).toMatch(/[\u3400-\u9fff]/u)
  }
})

test('default template names interpolate in both interface languages', () => {
  expect(
    i18n.getFixedT('zh-CN', 'common')('configTemplates.followDefaultWith', { name: 'fast-local' })
  ).toBe('跟随默认（fast-local）')
  expect(
    i18n.getFixedT('en', 'common')('configTemplates.followDefaultWith', { name: 'fast-local' })
  ).toBe('Follow the default (fast-local)')
})

test('extension management copy has the same keys in both interface languages', async () => {
  const [en, zh] = await Promise.all([
    import('./locales/en/extensions.json'),
    import('./locales/zh-CN/extensions.json'),
  ])
  // Chinese has no singular plural form; compare plural keys by their base name.
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) =>
          keys(child, `${prefix}${key.replace(/_(one|other)$/, '')}.`)
        )
      : [prefix]
  expect(Array.from(new Set(keys(zh.default))).sort()).toEqual(
    Array.from(new Set(keys(en.default))).sort()
  )
  expect(strings(zh.default).every(text => text.length > 0)).toBe(true)
})

test('self-evolution copy has the same keys in both interface languages', async () => {
  const [en, zh] = await Promise.all([
    import('./locales/en/evolution.json'),
    import('./locales/zh-CN/evolution.json'),
  ])
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
      : [prefix]
  expect(keys(zh.default).sort()).toEqual(keys(en.default).sort())
  expect(en.default.page.title).toBe('Self-evolution')
  expect(zh.default.page.title).toBe('自进化')
})
