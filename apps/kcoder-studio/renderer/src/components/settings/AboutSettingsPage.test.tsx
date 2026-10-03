import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import '@/i18n'
import { AboutSettingsPage } from './AboutSettingsPage'

const openExternalUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))

test('About links identify the real KCoder repository and license, without upstream community links', async () => {
  render(<AboutSettingsPage />)
  expect(screen.getByRole('heading')).toHaveTextContent('KCoder Studio')
  expect(screen.queryByTestId('about-link-discord')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('about-link-github'))
  expect(openExternalUrl).toHaveBeenLastCalledWith(
    'https://github.com/yixuanchen189756-source/KCoder'
  )
  await userEvent.click(screen.getByTestId('about-link-apache-2.0'))
  expect(openExternalUrl).toHaveBeenLastCalledWith('https://www.apache.org/licenses/LICENSE-2.0')
})

function updateState(overrides: Partial<AppUpdateContextValue> = {}): AppUpdateContextValue {
  return {
    supported: true,
    availableUpdate: null,
    status: 'idle',
    downloadProgress: null,
    message: null,
    error: null,
    checkNow: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    dismissError: vi.fn(),
    ...overrides,
  }
}

test('unsupported host explains unavailable updater without making a native request', async () => {
  const state = updateState({ supported: false })
  render(
    <AppUpdateContext.Provider value={state}>
      <AboutSettingsPage />
    </AppUpdateContext.Provider>
  )
  const button = screen.getByTestId('about-check-update-button')
  expect(button).toBeDisabled()
  expect(button).not.toHaveTextContent('检查更新')
  await userEvent.click(button)
  expect(state.checkNow).not.toHaveBeenCalled()
  expect(state.installUpdate).not.toHaveBeenCalled()
})

test('About update errors have a dismiss action and are cleared when leaving the page', async () => {
  const state = updateState({ status: 'error', error: 'Fixture update failed' })
  const view = render(
    <AppUpdateContext.Provider value={state}>
      <AboutSettingsPage />
    </AppUpdateContext.Provider>
  )
  expect(screen.getByTestId('about-update-status')).toHaveTextContent('Fixture update failed')
  await userEvent.click(screen.getByTestId('about-dismiss-update-error'))
  expect(state.dismissError).toHaveBeenCalledTimes(2)
  view.unmount()
  expect(state.dismissError).toHaveBeenCalledTimes(3)
  render(
    <AppUpdateContext.Provider value={updateState()}>
      <AboutSettingsPage />
    </AppUpdateContext.Provider>
  )
  expect(screen.queryByTestId('about-update-status')).not.toBeInTheDocument()
})
