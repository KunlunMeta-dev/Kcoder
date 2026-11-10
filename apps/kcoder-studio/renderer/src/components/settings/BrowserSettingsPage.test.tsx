import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/host/appPreferences'
import './../../../src/i18n'
import { BrowserSettingsPage } from './BrowserSettingsPage'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const clearEmbeddedBrowserDataMock = vi.hoisted(() => vi.fn())
const openNativeDirectoryPickerMock = vi.hoisted(() => vi.fn())
const nativeHostMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/lib/runtime-environment', () => ({ isNativeGatewayHost: nativeHostMock }))

const preferences: AppPreferences = vi.hoisted(() => ({
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'studio',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
}))

vi.mock('@/host/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/host/appPreferences')>()
  return {
    ...actual,
    defaultAppPreferences: preferences,
    getAppPreferences: getAppPreferencesMock,
    updateAppPreferences: updateAppPreferencesMock,
  }
})

vi.mock('@/lib/embedded-browser', () => ({
  canUseEmbeddedBrowser: () => true,
  clearEmbeddedBrowserData: clearEmbeddedBrowserDataMock,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeDirectoryPicker: openNativeDirectoryPickerMock,
}))

describe('BrowserSettingsPage', () => {
  beforeEach(() => {
    nativeHostMock.mockReturnValue(true)
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    clearEmbeddedBrowserDataMock.mockReset()
    openNativeDirectoryPickerMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(preferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...preferences, ...patch })
    )
    clearEmbeddedBrowserDataMock.mockResolvedValue(1)
    openNativeDirectoryPickerMock.mockResolvedValue(null)
  })

  test('renders configured link targets without implementation notices', async () => {
    render(<BrowserSettingsPage />)

    expect(await screen.findByTestId('browser-external-link-target')).toHaveValue('system')
    expect(screen.getByTestId('browser-local-link-target')).toHaveValue('studio')
    expect(screen.queryByText('Wework 内置浏览器可用')).not.toBeInTheDocument()
    expect(screen.queryByText('Google Chrome 个人资料')).not.toBeInTheDocument()
  })

  test('does not advertise local download controls for the download-blocked target browser', async () => {
    nativeHostMock.mockReturnValue(false)
    render(<BrowserSettingsPage />)
    expect(await screen.findByTestId('browser-downloads-unavailable')).toHaveTextContent('禁止下载')
    expect(screen.queryByTestId('browser-download-location-change')).not.toBeInTheDocument()
    expect(screen.queryByTestId('browser-ask-before-download-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('browser-external-link-target')).toBeInTheDocument()
    expect(openNativeDirectoryPickerMock).not.toHaveBeenCalled()
  })

  test('saves link routing and download prompt preferences', async () => {
    render(<BrowserSettingsPage />)
    const externalTarget = await screen.findByTestId('browser-external-link-target')
    await waitFor(() => expect(externalTarget).toBeEnabled())

    await userEvent.selectOptions(externalTarget, 'studio')
    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        browserExternalLinkTarget: 'studio',
      })
    )

  })


  test('requires confirmation before clearing browser data', async () => {
    render(<BrowserSettingsPage />)

    const clearButton = await screen.findByTestId('browser-clear-data-button')
    await waitFor(() => expect(clearButton).toBeEnabled())
    await userEvent.click(clearButton)
    expect(screen.getByTestId('browser-clear-data-dialog')).toBeInTheDocument()
    expect(clearEmbeddedBrowserDataMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('browser-clear-data-confirm'))

    await waitFor(() => expect(clearEmbeddedBrowserDataMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('browser-settings-status')).toHaveTextContent(
      '内置浏览器数据已清除'
    )
  })
})
