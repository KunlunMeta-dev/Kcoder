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
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    return {
      ok: true,
      json: async () =>
        url.includes('/mobile/pairing')
          ? { token: 'weekly-pairing-token', expiresAt: Date.now() + 60_000, devices: [],
              publicBaseUrl: 'https://relay.example/g/gateway-one' }
          : {
              token: init?.method === 'POST' ? token + '-replacement' : token,
              mobileWebToken: init?.method === 'POST' ? 'persistent-web-replacement' : 'persistent-web-token',
              linkKind: 'persistent',
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
  expect(sshLink.search).toBe('')
  expect(new URLSearchParams(sshLink.hash.slice(1)).get('code')).toBe(token)
  const relayLink = new URL(createBrowserLoginUrl('https://relay.example/g/gateway-one', token))
  expect(relayLink.pathname).toBe('/g/gateway-one/login')
  expect(relayLink.search).toBe('')
  expect(new URLSearchParams(relayLink.hash.slice(1)).get('code')).toBe(token)
  expect(new URL(createBrowserLoginUrl('http://localhost:19000', token, 'legacy')).searchParams.get('token')).toBe(token)
})

test('replaces Web links once while preserving the selected tunnel address', async () => {
  const user = userEvent.setup()
  render(<BrowserAccessSettingsPage />)
  const address = await screen.findByLabelText('访问地址')
  await user.click(address.closest('details')!.querySelector('summary')!)
  await user.clear(address)
  await user.type(address, 'http://localhost:19000')
  const before = fetchMock.mock.calls.filter(call => String(call[0]).includes('/api/gateway/browser-access')).length
  await user.click(screen.getByRole('button', { name: '使旧 Web 链接失效并更换' }))
  await waitFor(() => expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/api/gateway/browser-access')).length).toBeGreaterThan(before))
  expect(address).toHaveValue('http://localhost:19000')
  expect(screen.getByText(/Web 链接长期有效/)).toBeInTheDocument()
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  expect(fetchMock).toHaveBeenCalledWith('/api/gateway/browser-access?kind=persistent',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ token }) }))
})

test('shows local and public browser links and supports copy and open actions', async () => {
  const user = userEvent.setup({ writeToClipboard: false })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<BrowserAccessSettingsPage />)
  await screen.findByTestId('browser-access-settings-page')
  await waitFor(() => expect(screen.getByTestId('browser-access-qr')).toBeInTheDocument())
  const publicPanel = screen.getByTestId('browser-access-qr').closest('details')!
  expect(publicPanel).not.toHaveAttribute('open')
  await user.click(publicPanel.querySelector('summary')!)
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/gateway/browser-access?kind=persistent',
    expect.objectContaining({ cache: 'no-store' })
  )
  const local = screen.getByLabelText('访问地址').closest('details')!
  await user.click(local.querySelector('summary')!)
  await user.click(local.querySelector('button')!)
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/login#code=existing-gateway-token'
    )
  )
  await user.click(screen.getAllByRole('button', { name: '复制登录链接', exact: true })[0])
  expect(writeText).toHaveBeenLastCalledWith('https://relay.example/g/gateway-one/login#code=existing-gateway-token')
  await user.click(screen.getAllByRole('button', { name: '打开浏览器' })[0])
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://relay.example/g/gateway-one/login#code=existing-gateway-token',
    { target: 'system' }
  )
})

test('disables peer access while keeping desktop browser access', async () => {
  const user = userEvent.setup()
  const previous = fetchMock.getMockImplementation()!
  const surfaces = { desktopWeb: true, terminal: true }
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
  const app = await screen.findByRole('switch', { name: '终端配对' })
  expect(app).toBeChecked()
  await user.click(app)
  await waitFor(() => expect(app).not.toBeChecked())
  expect(screen.getByRole('switch', { name: '桌面 Web 公网访问' })).toBeChecked()
  expect(screen.getByLabelText('访问地址').closest('details')).not.toHaveAttribute('open')
})
