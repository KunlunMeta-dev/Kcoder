import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isGatewayRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/runtime-commands', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isGatewayRuntime: isGatewayRuntimeMock,
}))

const mergedDefaultPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'studio',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  quickPhrases: [
    {
      id: 'default-summary-progress',
      title: '总结当前进展',
      content: '总结目前完成的工作和下一步建议',
      mode: 'normal',
    },
    {
      id: 'default-create-plan',
      title: '制定实施计划',
      content: '分析需求并制定详细的实施计划',
      mode: 'plan',
    },
    {
      id: 'default-pursue-goal',
      title: '持续完成这个目标',
      content: '持续推进这个目标，直到真正完成',
      mode: 'goal',
    },
  ],
  conversationFontScale: 'normal',
  conversationLineSpacing: 'normal',
  conversationBlockSpacing: 'normal',
  conversationLetterSpacing: 'normal',
  conversationFontFamily: 'noto-sans-sc',
  thinkingCollapsedByDefault: true,
  toolsCollapsedByDefault: true,
}

describe('appPreferences', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    isGatewayRuntimeMock.mockReset()
  })

  test('uses default preferences outside Gateway', async () => {
    isGatewayRuntimeMock.mockReturnValue(false)

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('merges missing fields from stored preferences', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ showMainWindowOnLaunch: false })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      showMainWindowOnLaunch: false,
    })
  })

  test('falls back to the default language for invalid stored language values', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ language: 'fr' })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('normalizes stored browser preferences', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      browserExternalLinkTarget: 'studio',
      browserLocalLinkTarget: 'unsupported',
      browserDownloadDirectory: '  /tmp/downloads  ',
      browserAskBeforeDownload: true,
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      browserExternalLinkTarget: 'studio',
      browserDownloadDirectory: '/tmp/downloads',
      browserAskBeforeDownload: true,
    })
  })

  test('normalizes local conversation preferences and preserves explicit disclosure choices', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      conversationFontScale: 'large',
      conversationLineSpacing: 'compact',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })

    const { getAppPreferences } = await import('./appPreferences')
    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      conversationFontScale: 'large',
      conversationLineSpacing: 'compact',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })
  })

  test('falls back to valid local conversation preference defaults', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      conversationFontScale: 'giant',
      conversationLineSpacing: 'wide',
      thinkingCollapsedByDefault: 'false',
      toolsCollapsedByDefault: 0,
    })

    const { getAppPreferences } = await import('./appPreferences')
    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('preserves attachment-only stash phrases', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      quickPhrases: [
        {
          id: 'stash-file',
          title: 'image.png',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/image.png'],
        },
      ],
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      quickPhrases: [
        {
          id: 'stash-file',
          title: 'image.png',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/image.png'],
        },
      ],
    })
  })

  test('removes stash phrases after seven days and preserves regular phrases', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    const now = Date.now()
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      quickPhrases: [
        {
          id: `stash-${now - 7 * 24 * 60 * 60 * 1000}`,
          title: '过期暂存',
          content: '过期',
          mode: 'normal',
        },
        {
          id: 'stash-recent',
          title: '近期暂存',
          content: '近期',
          mode: 'normal',
          createdAt: now - 7 * 24 * 60 * 60 * 1000 + 1,
        },
        { id: 'regular', title: '普通短语', content: '保留', mode: 'normal' },
      ],
    })

    const { getAppPreferences } = await import('./appPreferences')
    const preferences = await getAppPreferences()

    expect(preferences.quickPhrases.map(phrase => phrase.id)).toEqual(['stash-recent', 'regular'])
    vi.useRealTimers()
  })

  test('updates preferences through the Gateway command', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      terminalContextInjectionEnabled: false,
      trayRunningEnabled: false,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ closeToTrayEnabled: false })).resolves.toEqual({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      terminalContextInjectionEnabled: false,
      trayRunningEnabled: false,
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { closeToTrayEnabled: false },
    })
  })

  test('updates language preferences through the Gateway command', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      language: 'en',
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ language: 'en' })).resolves.toEqual({
      ...mergedDefaultPreferences,
      language: 'en',
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { language: 'en' },
    })
  })

  test('saves conversation defaults through local app preferences', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      conversationFontScale: 'large',
      conversationLineSpacing: 'relaxed',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })

    const { updateAppPreferences } = await import('./appPreferences')
    await expect(updateAppPreferences({
      conversationFontScale: 'large',
      conversationLineSpacing: 'relaxed',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })).resolves.toMatchObject({
      conversationFontScale: 'large',
      conversationLineSpacing: 'relaxed',
      thinkingCollapsedByDefault: false,
      toolsCollapsedByDefault: false,
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: {
        conversationFontScale: 'large',
        conversationLineSpacing: 'relaxed',
        thinkingCollapsedByDefault: false,
        toolsCollapsedByDefault: false,
      },
    })
  })

  test('serializes a cleared browser download directory for the native command', async () => {
    isGatewayRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(mergedDefaultPreferences)

    const { updateAppPreferences } = await import('./appPreferences')

    await updateAppPreferences({ browserDownloadDirectory: null })

    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { browserDownloadDirectory: '' },
    })
  })
})

test('preserves all five line values and normalizes missing or invalid new reading fields', async () => {
  isGatewayRuntimeMock.mockReturnValue(true)
  const { getAppPreferences } = await import('./appPreferences')
  for (const value of ['compact', 'snug', 'normal', 'relaxed', 'airy']) {
    invokeMock.mockResolvedValue({ conversationLineSpacing: value, conversationBlockSpacing: 'relaxed', conversationLetterSpacing: 'compact', conversationFontFamily: 'system' })
    await expect(getAppPreferences()).resolves.toMatchObject({ conversationLineSpacing: value, conversationBlockSpacing: 'relaxed', conversationLetterSpacing: 'compact', conversationFontFamily: 'system' })
  }
  invokeMock.mockResolvedValue({ conversationBlockSpacing: 'invalid', conversationLetterSpacing: 'invalid', conversationFontFamily: 'invalid' })
  await expect(getAppPreferences()).resolves.toMatchObject({ conversationBlockSpacing: 'normal', conversationLetterSpacing: 'normal', conversationFontFamily: 'noto-sans-sc' })
})
