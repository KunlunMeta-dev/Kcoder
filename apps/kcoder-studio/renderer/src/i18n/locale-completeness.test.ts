import i18n from './index'
import { expect, test } from 'vitest'
import en from './locales/en/common.json'
import zh from './locales/zh-CN/common.json'

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
