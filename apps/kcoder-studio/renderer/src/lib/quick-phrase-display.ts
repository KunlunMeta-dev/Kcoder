import type { TFunction } from 'i18next'
import { defaultQuickPhrases, type QuickPhrase } from '@/tauri/appPreferences'

/** Reserved default IDs plus an unchanged payload identify shipped presets.
 * Any user edit converts the phrase to user content and preserves its language. */
export function localizeQuickPhrase(phrase: QuickPhrase, t: TFunction): QuickPhrase {
  const preset = defaultQuickPhrases.find(item => item.id === phrase.id)
  if (
    !preset ||
    phrase.title !== preset.title ||
    phrase.content !== preset.content ||
    phrase.mode !== preset.mode ||
    phrase.attachmentPaths?.length
  )
    return phrase
  return {
    ...phrase,
    title: t(`common:quickPhraseDefaults.${phrase.id}.title`),
    content: t(`common:quickPhraseDefaults.${phrase.id}.content`),
  }
}
