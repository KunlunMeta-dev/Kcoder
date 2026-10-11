import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { BrowserAccessSettingsPage } from './BrowserAccessSettingsPage'
import { openExternalUrl } from '@/lib/external-links'
import { createBrowserLoginUrl } from '@/kcoder/browserAccess'
import '@/i18n'

vi.mock('@/lib/external-links', () => ({ openExternalUrl: vi.fn().mockResolvedValue(true) }))

const token = 'existing-gateway-token'
const fetchMock = vi.fn()
const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    return {
      ok: true,
      json: async () =>
        url.includes('/mobile/pairing')
          ? { token: 'weekly-pairing-token', expiresAt: Date.now() + 60_000, devices: [] }
          : {
              token,
              localBaseUrl: 'http://127.0.0.1:4173',
              publicBaseUrl: 'https://relay.example/g/gateway-one',
            },
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  writeText.mockClear()
  vi.mocked(openExternalUrl).mockClear()
})

test('generates credential links for SSH overrides and relay routes without changing the token', () => {
  const sshLink = new URL(createBrowserLoginUrl('http://localhost:19000', token))
  expect(sshLink.origin).toBe('http://localhost:19000')
  expect(sshLink.searchParams.get('token')).toBe(token)
  expect(sshLink.searchParams.get('returnTo')).toBe('/')
  const relayLink = new URL(createBrowserLoginUrl('https://relay.example/g/gateway-one', token))
  expect(relayLink.pathname).toBe('/g/gateway-one/login')
  expect(relayLink.searchParams.get('returnTo')).toBe('/g/gateway-one/')
  expect(relayLink.searchParams.get('token')).toBe(token)
})

test('shows separate local and phone QR links and supports copy and open actions', async () => {
  const user = userEvent.setup({ writeToClipboard: false })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<BrowserAccessSettingsPage />)
  await screen.findByTestId('browser-access-settings-page')
  await waitFor(() => expect(screen.getByTestId('browser-access-qr')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByTestId('mobile-pairing-qr')).toBeInTheDocument())
  await user.clear(screen.getByTestId('mobile-web-address'))
  await user.type(screen.getByTestId('mobile-web-address'), 'https://mobile.example')
  await waitFor(() => expect(screen.getByTestId('mobile-web-pairing-qr')).toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/gateway/browser-access',
    expect.objectContaining({ cache: 'no-store' })
  )
  await user.click(screen.getAllByRole('button', { name: '复制' })[0])
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/login?token=existing-gateway-token&returnTo=%2F'
    )
  )
  await user.click(screen.getAllByRole('button', { name: '打开浏览器' })[1])
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://relay.example/g/gateway-one/login?token=existing-gateway-token&returnTo=%2Fg%2Fgateway-one%2F',
    { target: 'system' }
  )
})
