import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RuntimeTaskCloseGuard } from './RuntimeTaskCloseGuard'

const mocks = vi.hoisted(() => ({ hide: vi.fn(), save: vi.fn(), listener: undefined as (() => void) | undefined }))
vi.mock('@/lib/runtime-environment', () => ({ isGatewayRuntime: () => true }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/host/appPreferences', () => ({ updateAppPreferences: mocks.save }))
vi.mock('@/host/runtimeTaskCloseGuard', () => ({
  closeMainWindowToTray: mocks.hide,
  installRuntimeTaskCloseGuard: async (listener: () => void) => { mocks.listener = listener; return () => { mocks.listener = undefined } },
}))
vi.mock('./runtimeTaskLifecycle', () => ({ useRuntimeTaskLifecycleStoreSnapshot: () => ({ runningTaskKeys: new Set(['owned-task']) }) }))
beforeEach(() => { mocks.hide.mockReset(); mocks.save.mockReset(); mocks.listener = undefined })
afterEach(() => { delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })

async function openHint() {
  Object.assign(window, { kcoderDesktopHost: { getTrayCapabilities: async () => ({ available: true }) } })
  render(<RuntimeTaskCloseGuard />)
  await waitFor(() => expect(mocks.listener).toBeTypeOf('function'))
  act(() => { mocks.listener?.() })
  return screen.findByTestId('runtime-task-close-confirm-button')
}

test('an unavailable tray never advertises a tray hint or saves its acknowledgement', async () => {
  Object.assign(window, { kcoderDesktopHost: { getTrayCapabilities: async () => ({ available: false }) } })
  render(<RuntimeTaskCloseGuard />)
  await act(async () => {})
  expect(mocks.listener).toBeUndefined()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mocks.save).not.toHaveBeenCalled()
  expect(mocks.hide).not.toHaveBeenCalled()
})
test('only the acknowledged original hide can mark HintSeen; double click does not resend', async () => {
  let finish!: () => void
  mocks.hide.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  mocks.save.mockResolvedValue({})
  const button = await openHint()
  fireEvent.click(button); fireEvent.click(button)
  expect(mocks.hide).toHaveBeenCalledTimes(1)
  expect(mocks.save).not.toHaveBeenCalled()
  await act(async () => { finish() })
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ closeToTrayHintSeen: true })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
test('a lost hide receipt keeps the hint unacknowledged and never retries automatically', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.hide.mockRejectedValue(new Error('owned receipt missing'))
  const button = await openHint(); fireEvent.click(button)
  await screen.findByRole('alert')
  expect(mocks.hide).toHaveBeenCalledTimes(1)
  expect(mocks.save).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  log.mockRestore()
})
