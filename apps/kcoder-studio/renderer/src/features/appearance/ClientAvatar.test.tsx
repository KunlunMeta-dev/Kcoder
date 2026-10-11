import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ClientAvatar, ClientAvatarSettings } from './ClientAvatar'
import { saveClientAvatar } from './clientAvatarStore'
import { selectClientImage } from '@/lib/client-image'
import '@/i18n'

vi.mock('@/lib/client-image', async original => ({
  ...(await original<typeof import('@/lib/client-image')>()),
  selectClientImage: vi.fn(),
}))
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

test('avatar updates every visible instance, restores after remount, and can be removed', async () => {
  const image = 'data:image/webp;base64,UklGRg=='
  vi.mocked(selectClientImage).mockResolvedValue(image)
  const view = render(
    <>
      <ClientAvatar />
      <ClientAvatarSettings />
    </>
  )
  fireEvent.click(screen.getByTestId('client-avatar-select'))
  await waitFor(() => expect(screen.getAllByTestId('client-avatar-image')).toHaveLength(2))
  view.unmount()
  render(<ClientAvatarSettings />)
  expect(screen.getByTestId('client-avatar-image')).toHaveAttribute('src', image)
  fireEvent.click(screen.getByTestId('client-avatar-remove'))
  await waitFor(() => expect(screen.queryByTestId('client-avatar-image')).not.toBeInTheDocument())
})

test('rejects remote URLs and reports a local storage failure without losing the old avatar', async () => {
  expect(() => saveClientAvatar('https://example.test/tracker.svg')).toThrow()
  vi.mocked(selectClientImage).mockResolvedValue('data:image/webp;base64,UklGRg==')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  render(<ClientAvatarSettings />)
  fireEvent.click(screen.getByTestId('client-avatar-select'))
  await screen.findByRole('alert')
  expect(screen.queryByTestId('client-avatar-image')).not.toBeInTheDocument()
})
