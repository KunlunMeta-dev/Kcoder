import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { MobileConnectionSettingsPage } from './MobileConnectionSettingsPage'

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('@/kcoder/mobilePairing', () => ({
  fetchMobilePairingSettings: api.fetch,
  rotateMobilePairingCredential: api.rotate,
  revokeMobilePairingDevice: api.revoke,
}))

const initial = {
  token: 'a'.repeat(64),
  expiresAt: Date.now() + 60 * 60_000,
  publicBaseUrl: null as string | null,
  devices: [
    {
      id: 'device-1234567890123456',
      label: 'Test iPhone',
      createdAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 1_000,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  ],
}

describe('MobileConnectionSettingsPage', () => {
  beforeEach(() => {
    api.fetch.mockReset().mockResolvedValue(initial)
    api.rotate.mockReset().mockResolvedValue({
      token: 'b'.repeat(64),
      expiresAt: initial.expiresAt + 7 * 24 * 60 * 60_000,
    })
    api.revoke.mockReset().mockResolvedValue(undefined)
  })

  test('shows a QR code, rotates its credential, and lets the Gateway revoke a paired phone', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MobileConnectionSettingsPage />)

    const qr = await screen.findByTestId('mobile-pairing-qr')
    expect(qr.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByText('Test iPhone')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-pairing-expiry')).toHaveTextContent('二维码有效至')

    await user.click(screen.getByTestId('mobile-pairing-rotate'))
    expect(api.rotate).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(screen.getByTestId('mobile-pairing-qr').querySelector('svg')).toBeInTheDocument()
    )

    await user.click(screen.getByTestId('mobile-paired-device-revoke-device-1234567890123456'))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(api.revoke).toHaveBeenCalledWith('device-1234567890123456')
    await waitFor(() => expect(api.fetch).toHaveBeenCalledTimes(2))
  })

  test('does not render a QR code for an invalid mobile Gateway address', async () => {
    const user = userEvent.setup()
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    const address = screen.getByTestId('mobile-gateway-address')
    await user.clear(address)
    await user.type(address, 'javascript:alert(1)')
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getByText('请输入有效的 Gateway 地址以生成二维码。')).toBeInTheDocument()
  })

  test('does not offer a Mobile Web QR for a loopback address', async () => {
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    expect(screen.queryByTestId('mobile-web-pairing-qr')).not.toBeInTheDocument()
    expect(
      screen.getAllByText(
        '这个地址只在当前设备可访问。请填写手机可访问的局域网或公网 Mobile Web 地址后再扫码。'
      )
    ).toHaveLength(2)
  })

  test('uses the public Gateway route supplied by the relay without manual entry', async () => {
    api.fetch.mockResolvedValue({
      ...initial,
      publicBaseUrl: 'https://relay.example/g/gateway-one',
    })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    expect(screen.getByTestId('mobile-gateway-address')).toHaveValue(
      'https://relay.example/g/gateway-one'
    )
  })

  test('creates a Mobile Web QR that opens the connect route with the weekly pairing credential', async () => {
    const user = userEvent.setup({ writeToClipboard: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    api.fetch.mockResolvedValue({
      ...initial,
      publicBaseUrl: 'https://relay.example/g/gateway-one',
    })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-connection-settings-page')
    await user.clear(screen.getByTestId('mobile-web-address'))
    await user.type(screen.getByTestId('mobile-web-address'), 'https://mobile.example')
    await screen.findByTestId('mobile-web-pairing-qr')
    await user.click(screen.getByTestId('mobile-web-pairing-copy-link'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce()
      const link = new URL(writeText.mock.calls[0][0])
      expect(link.origin).toBe('https://mobile.example')
      expect(link.pathname).toBe('/connect')
      expect(link.searchParams.get('gateway')).toBe('https://relay.example/g/gateway-one')
      expect(link.searchParams.get('token')).toBe(initial.token)
    })
  })
})
