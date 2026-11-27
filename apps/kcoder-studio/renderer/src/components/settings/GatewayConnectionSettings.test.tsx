import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { GatewayConnectionSettings } from './GatewayConnectionSettings'

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

vi.mock('@/kcoder/gatewayAccess', () => ({
  fetchPeerPairingSettings: api.fetch,
  rotatePeerPairingCredential: api.rotate,
  revokePairedDevice: api.revoke,
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

describe('GatewayConnectionSettings', () => {
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

  test('the configured KCoder service enrolls through the product account without collecting relay credentials', async () => {
    const user = userEvent.setup()
    const origin = 'https://relay.example'
    api.relayState.mockResolvedValue({
      configured: false, publicBaseUrl: null, relayUrl: origin, productAccountOrigin: origin, restartRequired: false, restartSupported: true,
    })
    api.signInAccount.mockResolvedValue({ available: true, account: { id: 'fixture', username: 'fixture' } })
    api.activateRelay.mockResolvedValue({ configured: true, publicBaseUrl: 'https://relay.example/g/fixture', restartRequired: false, restartSupported: false, liveApplySupported: true })
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
      render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
    await screen.findByText('请通过启动此 Gateway 的原启动器重启服务；无需再次填写激活密钥。')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重启并生效' })).not.toBeInTheDocument()
    expect(api.activateRelay).not.toHaveBeenCalled()
  })

  test('shows Relay recovery failure without offering a replacement identity', async () => {
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl: null, restartRequired: true, restartSupported: false, restoreFailed: true })
    api.fetch.mockResolvedValue({ ...initial, publicBaseUrl: null })
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
    await screen.findByText('中继恢复暂不可用，Gateway 仍可在本机使用。请核对网络和原登记后，通过所属启动器重试。')
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
  })

  test('preserves an externally managed public address without claiming it is a Relay registration', async () => {
    const publicBaseUrl = 'https://relay.example/g/gateway-one'
    api.relayState.mockResolvedValue({ configured: false, publicBaseUrl, externallyManaged: true, accountAccessStatus: 'authorized', restartRequired: false, restartSupported: false })
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
    await screen.findByText('地址在启动时设置')
    expect(screen.getByText('公网访问已授权。').closest('details')).toHaveTextContent(publicBaseUrl)
    expect(screen.queryByText('在线')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('一次性激活链接')).not.toBeInTheDocument()
  })

  test('edits the Relay server and saves a revision-fenced selection', async () => {
    const user = userEvent.setup()
    api.relayState.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, relayUrl: 'https://relay.example', revision: 4, switchSupported: true, restartRequired: false, restartSupported: false })
    api.switchRelay.mockResolvedValue({ configured: true, publicBaseUrl: initial.publicBaseUrl, revision: 6, switchSupported: true, restartRequired: true, restartSupported: false,
      selectedRelay: { url: 'https://new.example', publicBaseUrl: 'https://g-new.new.example/g/new' },
      previousRelay: { url: 'https://relay.example', publicBaseUrl: initial.publicBaseUrl } })
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    const address = screen.getByLabelText('中继服务器地址（HTTPS）')
    await user.clear(address); await user.type(address, 'https://new.example')
    await user.type(screen.getByLabelText('一次性激活链接'), 'b'.repeat(43))
    await user.click(screen.getByRole('button', { name: '验证并保存切换' }))
    expect(api.switchRelay).toHaveBeenCalledWith({ relayUrl: 'https://new.example', activationLink: 'b'.repeat(43), expectedRevision: 4, requestId: expect.any(String) })
    await screen.findByTestId('gateway-relay-selected')
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
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
    render(<GatewayConnectionSettings desktopWeb={() => null} />)
    await user.click(await screen.findByRole('button', { name: '切换中继' }))
    await user.click(screen.getByLabelText('使用中继账户'))
    await user.type(screen.getByLabelText('密码'), 'fixture-account-password')
    await user.click(screen.getByRole('button', { name: '取消准备' }))
    await user.click(screen.getByRole('button', { name: '切换中继' }))
    await user.click(screen.getByLabelText('使用中继账户'))
    expect(screen.getByLabelText('密码')).toHaveValue('')
  })
})
