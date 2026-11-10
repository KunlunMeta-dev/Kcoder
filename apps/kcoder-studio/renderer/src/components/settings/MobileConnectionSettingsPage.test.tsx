import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { MobileConnectionSettingsPage } from './MobileConnectionSettingsPage'

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  relayState: vi.fn(),
  activateRelay: vi.fn(),
  restartRelay: vi.fn(),
  switchRelay: vi.fn(),
  cancelSwitch: vi.fn(),
  rollbackRelay: vi.fn(),
  fetchAccount: vi.fn(),
  signInAccount: vi.fn(),
  revokeRelay: vi.fn(),
}))

vi.mock('@/kcoder/mobilePairing', () => ({
  fetchMobilePairingSettings: api.fetch,
  rotateMobilePairingCredential: api.rotate,
  revokeMobilePairingDevice: api.revoke,
  fetchGatewayRelayState: api.relayState,
  activateGatewayRelay: api.activateRelay,
  restartGatewayForRelay: api.restartRelay,
  switchGatewayRelay: api.switchRelay,
  cancelGatewayRelaySwitch: api.cancelSwitch,
  rollbackGatewayRelay: api.rollbackRelay,
  fetchKCoderAccount: api.fetchAccount,
  signInKCoderAccount: api.signInAccount,
  revokeGatewayRelay: api.revokeRelay,
}))

const initial = {
  token: 'a'.repeat(64),
  expiresAt: Date.now() + 60 * 60_000,
  publicBaseUrl: 'https://relay.example/g/gateway-one' as string | null,
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
const pairingRoutes = {
  version: 1 as const,
  gatewayId: 'a'.repeat(64),
  publicKey: 'b'.repeat(64),
  endpoints: [
    { kind: 'lan' as const, url: 'http://192.168.1.20:4173' },
    { kind: 'public' as const, url: 'https://relay.example/g/gateway-one' },
  ],
}

describe('MobileConnectionSettingsPage', () => {
  afterEach(() => { delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost })
  beforeEach(() => {
    api.relayState.mockReset().mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, restartRequired: false, restartSupported: false })
    api.activateRelay.mockReset()
    api.switchRelay.mockReset()
    api.cancelSwitch.mockReset()
    api.rollbackRelay.mockReset()
    api.restartRelay.mockReset().mockResolvedValue(undefined)
    api.fetchAccount.mockReset().mockResolvedValue({ available: true, account: null })
    api.signInAccount.mockReset()
    api.revokeRelay.mockReset().mockResolvedValue(undefined)
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

  test('waits for the public proof before publishing a pairing QR code', async () => {
    api.fetch.mockResolvedValueOnce({ ...initial, publicReadiness: 'preparing' })
      .mockResolvedValue({ ...initial, publicReadiness: 'ready' })
    render(<MobileConnectionSettingsPage />)

    expect(await screen.findAllByText('正在准备 Gateway 公网入口，就绪后会显示二维码。')).not.toHaveLength(0)
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-pairing-copy-link')).toBeDisabled()
    expect(await screen.findByTestId('mobile-pairing-qr', undefined, { timeout: 4_000 })).toBeInTheDocument()
    expect(screen.getByTestId('mobile-pairing-copy-link')).toBeEnabled()
  })

  test('does not render a QR code for an invalid mobile Gateway address', async () => {
    const user = userEvent.setup()
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    const address = screen.getByTestId('mobile-gateway-address')
    await user.clear(address)
    await user.type(address, 'javascript:alert(1)')
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getAllByText('请输入有效的 Gateway 地址以生成二维码。')).toHaveLength(2)
  })

  test('does not offer a native QR or copy link for a loopback Gateway', async () => {
    api.fetch.mockResolvedValue({ ...initial, publicBaseUrl: null })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-pairing-copy-link')).toBeDisabled()
    expect(screen.getAllByText(
      '此配对地址仅在电脑本机可用。请在桌面端启用中继后，重新生成二维码。'
    ).length).toBeGreaterThan(0)
  })

  test.each(['browser', 'desktop'])('uses the same Gateway activation API in %s', async host => {
    if (host === 'desktop') Object.assign(window, { kcoderDesktopHost: {} })
    const user = userEvent.setup()
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl: null, restartRequired: false, restartSupported: true })
    api.activateRelay.mockResolvedValue({ configured: false, publicBaseUrl: 'https://relay.example/g/new', restartRequired: true, restartSupported: true })
    api.fetch.mockResolvedValue({ ...initial, publicBaseUrl: null })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MobileConnectionSettingsPage />)
    const input = await screen.findByLabelText('一次性激活链接')
    const link = `https://relay.example/_relay/activate#code=${'a'.repeat(43)}`
    await user.type(input, link)
    await user.click(screen.getByRole('button', { name: '激活当前 Gateway' }))
    expect(api.activateRelay).toHaveBeenCalledWith({ activationLink: link, relayUrl: 'https://relay.example' })
    await screen.findByRole('button', { name: '重启并生效' })
    expect(api.restartRelay).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重启并生效' }))
    expect(api.restartRelay).toHaveBeenCalledOnce()
  })

  test('the configured KCoder service enrolls through the product account without collecting relay credentials', async () => {
    const user = userEvent.setup()
    const origin = 'https://relay.example'
    api.relayState.mockResolvedValue({
      configured: false, publicBaseUrl: null, relayUrl: origin, productAccountOrigin: origin, restartRequired: false, restartSupported: true,
    })
    api.signInAccount.mockResolvedValue({ available: true, account: { id: 'fixture', username: 'fixture' } })
    api.activateRelay.mockResolvedValue({ configured: true, publicBaseUrl: 'https://relay.example/g/fixture', restartRequired: false, restartSupported: false, liveApplySupported: true })
    render(<MobileConnectionSettingsPage />)
    expect(await screen.findByRole('button', { name: '激活当前 Gateway' })).toBeDisabled()
    const signIn = screen.getByRole('button', { name: '登录 KCoder' })
    expect(signIn).toHaveAccessibleDescription('使用 KCoder 的公网服务前，请先登录 KCoder 账号。')
    expect(screen.queryByText(/粘贴管理员生成的一次性激活链接/)).not.toBeInTheDocument()
    await user.click(signIn)
    const dialog = await screen.findByRole('dialog')
    const username = dialog.querySelector('input[name="username"]')!
    const password = dialog.querySelector('input[name="password"]')!
    await user.type(username, 'fixture')
    await user.type(password, 'fixture-account-password')
    await user.click(dialog.querySelector('button[type="submit"]')!)
    await screen.findByText('将使用当前登录的 KCoder 账号设置公网访问。')
    expect(screen.queryByRole('button', { name: '登录 KCoder' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '激活当前 Gateway' }))
    expect(api.signInAccount).toHaveBeenCalledWith(origin + '/_relay/account/', 'fixture', 'fixture-account-password')
    expect(api.activateRelay).toHaveBeenCalledWith({ useKCoderAccount: true })
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
    expect(await screen.findByTestId('gateway-relay-configured')).toHaveTextContent('https://relay.example/g/fixture')
    expect(screen.queryByRole('button', { name: '重启并生效' })).not.toBeInTheDocument()
    expect(api.restartRelay).not.toHaveBeenCalled()
  })

  test('shows the existing Gateway registration on the web without an activation form', async () => {
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('gateway-relay-configured')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
    expect(api.activateRelay).not.toHaveBeenCalled()
  })

  test('offers revocation on a public Relay page and reports a lost receipt as unconfirmed', async () => {
    const user = userEvent.setup()
    const browser = (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom
    const originalUrl = window.location.href
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    browser.reconfigure({ url: 'https://relay.example/g/gateway-one/settings/access-links' })
    try {
      api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: 'https://relay.example/g/gateway-one',
        revision: 3, revokeSupported: true, liveApplySupported: true })
      api.revokeRelay.mockRejectedValueOnce(new TypeError('connection closed'))
      render(<MobileConnectionSettingsPage />)
      await user.click(await screen.findByRole('button', { name: '关闭公网连接' }))
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('通过公网打开的页面会断开'))
      expect(api.revokeRelay).toHaveBeenCalledWith(3)
      await screen.findByText(/无法确认公网连接是否已关闭/)
    } finally {
      browser.reconfigure({ url: originalUrl })
      confirm.mockRestore()
    }
  })

  test('restores pending activation after reload and explains manual restart without a supervisor', async () => {
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl: null, restartRequired: true, restartSupported: false })
    api.fetch.mockResolvedValue({ ...initial, publicBaseUrl: null })
    render(<MobileConnectionSettingsPage />)
    await screen.findByText('请通过启动此 Gateway 的原启动器重启服务；无需再次填写激活密钥。')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重启并生效' })).not.toBeInTheDocument()
    expect(api.activateRelay).not.toHaveBeenCalled()
  })

  test('shows Relay recovery failure without offering a replacement identity', async () => {
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl: null, restartRequired: true, restartSupported: false, restoreFailed: true })
    api.fetch.mockResolvedValue({ ...initial, publicBaseUrl: null })
    render(<MobileConnectionSettingsPage />)
    await screen.findByText('中继恢复暂不可用，Gateway 仍可在本机使用。请核对网络和原登记后，通过所属启动器重试。')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
  })

  test('preserves an externally managed public address without claiming it is a Relay registration', async () => {
    const publicBaseUrl = 'https://relay.example/g/gateway-one'
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl, externallyManaged: true, accountAccessStatus: 'authorized', restartRequired: false, restartSupported: false })
    render(<MobileConnectionSettingsPage />)
    await screen.findByText('地址在启动时设置')
    expect(screen.getByText('公网访问已授权。').closest('details')).toHaveTextContent(publicBaseUrl)
    expect(screen.queryByText('在线')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
  })

  test('edits the Relay server and saves a revision-fenced selection while keeping the active phone URL', async () => {
    const user = userEvent.setup()
    api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example', revision: 4, switchSupported: true, restartRequired: false, restartSupported: false })
    api.switchRelay.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 6, switchSupported: true, restartRequired: true, restartSupported: false,
      selectedRelay: { url: 'https://new.example', publicBaseUrl: 'https://g-new.new.example/g/new' },
      previousRelay: { url: 'https://relay.example', publicBaseUrl: initial.publicBaseUrl } })
    render(<MobileConnectionSettingsPage />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    const address = screen.getByLabelText('中继服务器地址（HTTPS）')
    await user.clear(address); await user.type(address, 'https://new.example')
    await user.type(screen.getByLabelText('一次性激活链接'), 'b'.repeat(43))
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    expect(api.switchRelay).toHaveBeenCalledWith({ relayUrl: 'https://new.example', activationLink: 'b'.repeat(43), expectedRevision: 4, requestId: expect.any(String) })
    await screen.findByTestId('gateway-relay-selected')
    expect(screen.getByTestId('mobile-gateway-address')).toHaveValue(initial.publicBaseUrl)
    expect(api.restartRelay).not.toHaveBeenCalled()
    api.rollbackRelay.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 7, restartRequired: false, restartSupported: false })
    await user.click(screen.getByRole('button', { name: '恢复上一个中继' }))
    expect(api.rollbackRelay).toHaveBeenCalledWith(6)
    await waitFor(() => expect(screen.queryByTestId('gateway-relay-selected')).not.toBeInTheDocument())
  })

  test('failed verification reloads its durable candidate and retries without another key', async () => {
    const user = userEvent.setup()
    api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example', revision: 0, switchSupported: true, restartRequired: false, restartSupported: false })
    api.switchRelay.mockImplementationOnce(async input => {
      api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 1, switchSupported: true, restartRequired: false, restartSupported: false,
        switchAttempt: { id: input.requestId, url: 'https://new.example', needsActivation: false } })
      throw Error('verification unavailable')
    })
    render(<MobileConnectionSettingsPage />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    const link = `https://new.example/_relay/activate#code=${'b'.repeat(43)}`
    await user.type(screen.getByLabelText('一次性激活链接'), link)
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    await screen.findByTestId('gateway-relay-attempt')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
    const requestId = api.switchRelay.mock.calls[0][0].requestId
    api.switchRelay.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 2, restartRequired: true, restartSupported: false })
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    expect(api.switchRelay.mock.calls[1][0]).toEqual({ requestId, expectedRevision: 1, relayUrl: 'https://new.example' })
  })

  test('clears account password after recovery finds the registered candidate and omits it on retry', async () => {
    const user = userEvent.setup()
    api.relayState
      .mockResolvedValueOnce({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example', revision: 0, switchSupported: true, restartRequired: false, restartSupported: false })
      .mockResolvedValueOnce({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example', revision: 1, switchSupported: true, restartRequired: false, restartSupported: false,
        switchAttempt: { id: '00000000-0000-4000-8000-000000000001', url: 'https://new.example', needsActivation: false } })
    api.switchRelay.mockRejectedValueOnce(Error('verification unavailable')).mockResolvedValueOnce({
      configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 2, restartRequired: true, restartSupported: false,
    })
    render(<MobileConnectionSettingsPage />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    await user.clear(screen.getByLabelText('中继服务器地址（HTTPS）'))
    await user.type(screen.getByLabelText('中继服务器地址（HTTPS）'), 'https://new.example')
    await user.click(screen.getByLabelText('使用中继账户'))
    await user.type(screen.getByLabelText('用户名'), 'fixture.user')
    await user.type(screen.getByLabelText('密码'), 'fixture-account-password')
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    expect(api.switchRelay.mock.calls[0][0]).toMatchObject({ accountCredentials: { username: 'fixture.user', password: 'fixture-account-password' } })
    await screen.findByTestId('gateway-relay-attempt')
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    expect(api.switchRelay.mock.calls[1][0]).toEqual({ requestId: '00000000-0000-4000-8000-000000000001', expectedRevision: 1, relayUrl: 'https://new.example' })
  })

  test.each(['activation', 'switch'])('recognizes a completed %s after losing the response and discards the credentials', async operation => {
    const user = userEvent.setup()
    const switching = operation === 'switch'
    const state = { configured: switching, needsLogin: !switching, publicBaseUrl: switching ? initial.publicBaseUrl : null,
      relayUrl: 'https://relay.example', revision: 0, switchSupported: switching, restartRequired: false, restartSupported: true }
    api.relayState.mockResolvedValue(state)
    const request = switching ? api.switchRelay : api.activateRelay
    request.mockImplementationOnce(async input => {
      api.relayState.mockResolvedValue({ ...state, needsLogin: false, restartRequired: true,
        selectedProfileId: input.requestId, revision: 2 })
      throw Error('response lost')
    })
    render(<MobileConnectionSettingsPage />)
    if (switching) await user.click(await screen.findByRole('button', { name: '切换中继' }))
    await user.click(await screen.findByLabelText('使用中继账户'))
    await user.type(screen.getByLabelText('用户名'), 'fixture.user')
    await user.type(screen.getByLabelText('密码'), 'fixture-account-password')
    await user.click(screen.getByRole('button', { name: switching ? '验证并保存切换' : '激活当前 Gateway' }))
    await screen.findByRole('button', { name: '重启并生效' })
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledOnce()
  })

  test('discards unsent account credentials when cancelling the Relay switch', async () => {
    const user = userEvent.setup()
    api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example',
      switchSupported: true, restartRequired: false, restartSupported: false })
    render(<MobileConnectionSettingsPage />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    await user.click(screen.getByLabelText('使用中继账户'))
    await user.type(screen.getByLabelText('密码'), 'fixture-account-password')
    await user.click(screen.getByRole('button', { name: '取消准备' }))
    await user.click(screen.getByRole('button', { name: '切换中继' }))
    await user.click(screen.getByLabelText('使用中继账户'))
    expect(screen.getByLabelText('密码')).toHaveValue('')
  })

  test('does not offer a Mobile Web QR for a loopback address', async () => {
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    expect(screen.queryByTestId('mobile-web-pairing-qr')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        '这个地址只在当前设备可访问。请填写手机可访问的局域网或公网 Mobile Web 地址后再扫码。'
      )
    ).toBeVisible()
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

  test('keeps the legacy single-address native QR when no connection descriptor is available', async () => {
    const user = userEvent.setup({ writeToClipboard: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-qr')
    await user.click(screen.getByTestId('mobile-pairing-copy-link'))
    const link = new URL(writeText.mock.calls[0][0])
    expect(link.protocol).toBe('kcoder-studio:')
    expect(link.searchParams.get('token')).toBe(initial.token)
    expect(link.searchParams.has('routes')).toBe(false)
  })

  test('fails closed when the entered address is outside the advertised descriptor', async () => {
    const user = userEvent.setup()
    api.fetch.mockResolvedValue({
      ...initial,
      publicBaseUrl: 'https://relay.example/g/gateway-one',
      connectionRoutes: pairingRoutes,
    })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    await user.clear(screen.getByTestId('mobile-gateway-address'))
    await user.type(screen.getByTestId('mobile-gateway-address'), 'https://custom.example')
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getAllByText('当前地址不在 Gateway 公布的候选路由中，无法生成配对二维码。')).toHaveLength(2)
    expect(screen.getByTestId('mobile-pairing-copy-link')).toBeDisabled()
  })

  test('fails closed when the Gateway includes an invalid descriptor instead of silently downgrading', async () => {
    api.fetch.mockResolvedValue({
      ...initial,
      connectionRoutes: { ...pairingRoutes, publicKey: 'invalid' },
    })
    render(<MobileConnectionSettingsPage />)
    await screen.findByTestId('mobile-pairing-expiry')
    expect(screen.queryByTestId('mobile-pairing-qr')).not.toBeInTheDocument()
    expect(screen.getAllByText('Gateway 提供的连接路由无效，请刷新配对状态后再生成二维码。')).toHaveLength(2)
  })

  test('puts one validated descriptor in both QR formats and keeps the Web token in the fragment', async () => {
    const user = userEvent.setup({ writeToClipboard: false })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    api.fetch.mockResolvedValue({
      ...initial,
      publicBaseUrl: 'https://relay.example/g/gateway-one',
      connectionRoutes: pairingRoutes,
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
      expect(link.searchParams.get('gatewayId')).toBe('gateway-one')
      expect(JSON.parse(link.searchParams.get('routes')!)).toEqual({ ...pairingRoutes, endpoints: pairingRoutes.endpoints.filter(endpoint => endpoint.kind === 'public') })
      expect(link.searchParams.has('token')).toBe(false)
      expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe(initial.token)
      expect(link.href).not.toContain(`token=${initial.token}&`)
    })

    await user.click(screen.getByTestId('mobile-pairing-copy-link'))
    const nativeLink = new URL(writeText.mock.calls[1][0])
    expect(nativeLink.searchParams.get('gatewayId')).toBe('gateway-one')
    expect(JSON.parse(nativeLink.searchParams.get('routes')!)).toEqual({ ...pairingRoutes, endpoints: pairingRoutes.endpoints.filter(endpoint => endpoint.kind === 'public') })
    expect(nativeLink.searchParams.get('token')).toBe(initial.token)
  })
})
