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
          ? { token: 'weekly-pairing-token', expiresAt: Date.now() + 60_000, devices: [],
              publicBaseUrl: 'https://relay.example/g/gateway-one' }
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
  expect(screen.getByTestId('browser-access-qr').closest('details')).not.toHaveAttribute('open')
  for (const section of [screen.getByTestId('mobile-web-address'), screen.getByTestId('browser-access-qr')]) {
    await user.click(section.closest('details')!.querySelector('summary')!)
  }
  await user.clear(screen.getByTestId('mobile-web-address'))
  await user.type(screen.getByTestId('mobile-web-address'), 'https://mobile.example')
  await waitFor(() => expect(screen.getByTestId('mobile-web-pairing-qr')).toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/gateway/browser-access',
    expect.objectContaining({ cache: 'no-store' })
  )
  const local = screen.getByLabelText('访问地址').closest('details')!
  await user.click(local.querySelector('summary')!)
  await user.click(local.querySelector('button')!)
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/login?token=existing-gateway-token&returnTo=%2F'
    )
  )
  await user.click(screen.getAllByRole('button', { name: '打开浏览器' })[0])
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://relay.example/g/gateway-one/login?token=existing-gateway-token&returnTo=%2Fg%2Fgateway-one%2F',
    { target: 'system' }
  )
})

test('disables App public access while keeping the Web and local entry points', async () => {
  const user = userEvent.setup()
  const previous = fetchMock.getMockImplementation()!
  const surfaces = { desktopWeb: true, mobileWeb: true, mobileApp: true }
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/relay')) return {
      ok: true,
      json: async () => ({ publicBaseUrl: 'https://relay.example/g/gateway-one',
        configured: true, publicAccess: { revision: 1, surfaces } }),
    }
    if (url.endsWith('/api/relay/public-access')) return {
      ok: true,
      json: async () => ({ revision: 2, surfaces: JSON.parse(init.body).surfaces }),
    }
    return previous(input, init)
  })
  render(<BrowserAccessSettingsPage />)
  const app = await screen.findByRole('switch', { name: '手机 App 公网访问' })
  expect(app).toBeChecked()
  await user.click(app)
  await waitFor(() => expect(app).not.toBeChecked())
  expect(screen.getByRole('switch', { name: '移动 Web 公网访问' })).toBeChecked()
  expect(screen.getByRole('switch', { name: '桌面 Web 公网访问' })).toBeChecked()
  expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
  expect(screen.getByTestId('mobile-web-pairing-qr').closest('details')).not.toHaveAttribute('open')
  expect(screen.getByLabelText('访问地址').closest('details')).not.toHaveAttribute('open')
})
