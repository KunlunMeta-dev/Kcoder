import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import { defaultQuickPhrases } from '@/tauri/appPreferences'
import { localizeQuickPhrase } from './quick-phrase-display'
import en from '@/i18n/locales/en/common.json'
import zh from '@/i18n/locales/zh-CN/common.json'

describe('shipped quick phrase localization', () => {
  it('changes untouched presets with the locale while preserving edited/user content', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'en', resources: { en: { common: en }, 'zh-CN': { common: zh } } })
    const preset = defaultQuickPhrases[0]
    expect(localizeQuickPhrase(preset, i18n.t).title).toBe('Summarize progress')
    expect(localizeQuickPhrase({ ...preset, content: 'My own text' }, i18n.t).title).toBe(
      preset.title
    )
    expect(localizeQuickPhrase({ ...preset, id: 'custom' }, i18n.t).title).toBe(preset.title)
    await i18n.changeLanguage('zh-CN')
    expect(localizeQuickPhrase(preset, i18n.t).title).toBe(preset.title)
  })
})

it('provides shared dialog actions in both languages without fallback copy', () => {
  for (const locale of [en, zh]) {
    for (const key of ['add', 'cancel', 'close', 'delete', 'done', 'open_menu', 'retry', 'save'] as const) {
      expect(locale.common[key].trim()).not.toBe('')
    }
  }
})
