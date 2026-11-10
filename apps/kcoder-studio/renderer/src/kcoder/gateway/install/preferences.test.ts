import { beforeEach, describe, expect, it } from 'vitest'
import { PREFERENCES_KEY, readPreferences, writePreferences } from './preferences'

describe('Electron Gateway local app preferences', () => {
  beforeEach(() => {
    localStorage.removeItem(PREFERENCES_KEY)
  })

  it('restores conversation defaults and quick phrases across full-snapshot writes', () => {
    const quickPhrases = [
      { id: 'review', title: 'Review', content: 'Review the current change', mode: 'normal' },
    ]
    writePreferences({
      language: 'en',
      quickPhrases,
      conversationFontScale: 'large',
      conversationLineSpacing: 'airy',
      conversationBlockSpacing: 'relaxed',
      conversationLetterSpacing: 'compact',
      conversationFontFamily: 'system',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })

    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')).toMatchObject({
      conversationFontScale: 'large',
      conversationLineSpacing: 'airy',
      conversationBlockSpacing: 'relaxed',
      conversationLetterSpacing: 'compact',
      conversationFontFamily: 'system',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
      quickPhrases,
    })
    expect(readPreferences()).toMatchObject({
      conversationFontScale: 'large',
      conversationLineSpacing: 'airy',
      conversationBlockSpacing: 'relaxed',
      conversationLetterSpacing: 'compact',
      conversationFontFamily: 'system',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
      quickPhrases,
    })

    writePreferences({ language: 'zh-CN' })
    expect(readPreferences()).toMatchObject({
      language: 'zh-CN',
      conversationFontScale: 'large',
      conversationLineSpacing: 'airy',
      conversationBlockSpacing: 'relaxed',
      conversationLetterSpacing: 'compact',
      conversationFontFamily: 'system',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
      quickPhrases,
    })
  })
})
