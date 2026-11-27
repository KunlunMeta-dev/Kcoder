import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { LocalCodexPluginApi, PluginProxySettings } from '@/api/local/codexPlugins'
import { PluginProxyControl } from './PluginProxyControl'
import { GatewayRpcError, GatewayRpcTimeoutError } from '@/kcoder/gatewayRpc'
import { createKCoderPluginApi } from '@/kcoder/gatewayPluginApi'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: rpc }))

const off: PluginProxySettings = {
  autoDetect: false,
  configuredUrl: 'http://127.0.0.1:9000',
  detectedUrl: null,
  checkedPorts: 0,
  status: 'disabled',
}

test.each([
  ['plugin_update_required', 'remote', /尚不支持|does not support/],
  ['plugin_scope_changed', 'remote', /账号已变化|account changed/],
  ['plugin_proxy_owner_busy', 'remote', /另一连接|Another connection/],
  ['plugin_proxy_connection_unavailable', 'connection', /连接不可用|disconnected/],
] as const)('proxy failures explain %s without exposing remote credentials', async (kind, reason, expected) => {
  const api = { getProxySettings: vi.fn().mockRejectedValue(new GatewayRpcError(
    'http://proxy-user:private-proxy-value@127.0.0.1:9000', -32000, { kind }, 'plugin-manage', reason
  )) } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(expected)
  expect(alert).not.toHaveTextContent('private-proxy-value')
  expect(alert).not.toHaveTextContent('proxy-user')
  expect(api.getProxySettings).toHaveBeenCalledTimes(1)
})
test('one switch enables verified proxy selection and preserves manual fallback', async () => {
  const configure = vi.fn().mockResolvedValue({
    ...off,
    autoDetect: true,
    detectedUrl: 'socks5h://127.0.0.1:1080',
    checkedPorts: 2,
    status: 'detected',
  })
  const api = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: configure,
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} probeUrl="https://github.com/repo" />)
  const toggle = screen.getByTestId('plugins-auto-proxy-switch')
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(configure).not.toHaveBeenCalled()
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(screen.getByRole('status')).toHaveTextContent('socks5h://127.0.0.1:1080')
  expect(configure).toHaveBeenCalledWith(true, 'https://github.com/repo')
})
test('a target change cannot display the old pending detection', async () => {
  let finish!: (value: PluginProxySettings) => void
  const oldApi = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: vi.fn(
      () =>
        new Promise<PluginProxySettings>(resolve => {
          finish = resolve
        })
    ),
  } as unknown as LocalCodexPluginApi
  const newApi = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: vi.fn(),
  } as unknown as LocalCodexPluginApi
  const view = render(<PluginProxyControl key="old" api={oldApi} />)
  await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).not.toBeDisabled())
  await userEvent.click(screen.getByTestId('plugins-auto-proxy-switch'))
  view.rerender(<PluginProxyControl key="new" api={newApi} />)
  finish({ ...off, autoDetect: true, detectedUrl: 'http://127.0.0.1:8888', status: 'detected' })
  await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).not.toBeDisabled())
  expect(screen.getByTestId('plugins-auto-proxy-switch')).toHaveAttribute('aria-checked', 'false')
  expect(screen.queryByText(/127.0.0.1:8888/)).not.toBeInTheDocument()
})

test('changing API without remount discards old pending target results', async () => {
  let finish!: (value: PluginProxySettings) => void
  const oldApi = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: vi.fn(
      () =>
        new Promise<PluginProxySettings>(resolve => {
          finish = resolve
        })
    ),
  } as unknown as LocalCodexPluginApi
  const newApi = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: vi.fn(),
  } as unknown as LocalCodexPluginApi
  const view = render(<PluginProxyControl api={oldApi} targetLabel="SSH target A" />)
  await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).not.toBeDisabled())
  await userEvent.click(screen.getByTestId('plugins-auto-proxy-switch'))
  view.rerender(<PluginProxyControl api={newApi} targetLabel="SSH target B" />)
  finish({ ...off, autoDetect: true, detectedUrl: 'http://127.0.0.1:61234', status: 'detected' })
  await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).not.toBeDisabled())
  expect(screen.getByTestId('plugins-auto-proxy-switch')).toHaveAttribute('aria-checked', 'false')
  expect(screen.queryByText(/127.0.0.1:61234/)).not.toBeInTheDocument()
})

test('renders cache counts and source hosts without source secrets', async () => {
  const api = {
    getProxySettings: vi.fn().mockResolvedValue({
      ...off,
      autoDetect: true,
      status: 'detected',
      detectedUrl: 'http://user:secret@[::1]:61234/path?token=secret',
      source: 'cache',
      quickChecks: 1,
      checkedCandidates: 0,
      targetHosts: ['https://source.test/private?token=secret'],
    }),
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} targetLabel="SSH target" />)
  await waitFor(() => expect(screen.getByTestId('plugins-proxy-details')).toBeInTheDocument())
  expect(screen.getByRole('status')).toHaveTextContent('http://[::1]:61234')
  expect(screen.getByTestId('plugins-proxy-details')).not.toHaveTextContent('secret')
  expect(screen.getByRole('status')).not.toHaveTextContent('user')
})

test('a stale read cannot replace the proxy setting already confirmed by a write', async () => {
  let finish!: (value: PluginProxySettings) => void
  const api = {
    getProxySettings: vi
      .fn()
      .mockResolvedValueOnce(off)
      .mockImplementationOnce(
        () =>
          new Promise<PluginProxySettings>(resolve => {
            finish = resolve
          })
      ),
    configureAutoProxy: vi.fn().mockResolvedValue({
      ...off,
      autoDetect: true,
      status: 'detected',
      detectedUrl: 'http://127.0.0.1:61234',
    }),
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const toggle = screen.getByTestId('plugins-auto-proxy-switch')
  await waitFor(() => expect(toggle).toBeEnabled())
  act(() => window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')))
  await waitFor(() => expect(api.getProxySettings).toHaveBeenCalledTimes(2))
  await userEvent.click(toggle)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('61234'))
  await act(async () => finish(off))
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(screen.getByRole('status')).toHaveTextContent('61234')
})

test('a failed refresh keeps the known setting and offers a retry', async () => {
  const api = {
    getProxySettings: vi
      .fn()
      .mockResolvedValueOnce({
        ...off,
        autoDetect: true,
        status: 'detected',
        detectedUrl: 'http://127.0.0.1:61234',
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        ...off,
        autoDetect: true,
        status: 'detected',
        detectedUrl: 'http://127.0.0.1:61234',
      }),
    configureAutoProxy: vi.fn(),
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('61234'))
  act(() => window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')))
  await screen.findByRole('alert')
  expect(screen.getByRole('status')).toHaveTextContent('61234')
  expect(screen.getByTestId('plugins-auto-proxy-switch')).toHaveAttribute('aria-checked', 'true')
  await userEvent.click(screen.getByTestId('plugins-auto-proxy-retry'))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

test('an obsolete read failure cannot hide or unlock an active write', async () => {
  let rejectRead!: (error: Error) => void
  let finishWrite!: (value: PluginProxySettings) => void
  const api = {
    getProxySettings: vi
      .fn()
      .mockResolvedValueOnce(off)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectRead = reject
          })
      ),
    configureAutoProxy: vi.fn(
      () =>
        new Promise<PluginProxySettings>(resolve => {
          finishWrite = resolve
        })
    ),
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const toggle = screen.getByTestId('plugins-auto-proxy-switch')
  await waitFor(() => expect(toggle).toBeEnabled())
  act(() => window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')))
  await waitFor(() => expect(api.getProxySettings).toHaveBeenCalledTimes(2))
  await userEvent.click(toggle)
  await act(async () => rejectRead(new Error('obsolete read failed')))
  expect(toggle).toBeDisabled()
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent(/正在|Scanning/)
  await act(async () => finishWrite({ ...off, autoDetect: true, status: 'not_found' }))
  expect(toggle).toBeEnabled()
})

test('catalog invalidation bursts coalesce into one trailing read', async () => {
  let finish!: (value: PluginProxySettings) => void
  const get = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<PluginProxySettings>(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue({
      ...off,
      autoDetect: true,
      status: 'detected',
      detectedUrl: 'http://127.0.0.1:61234',
    })
  const api = { getProxySettings: get } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
  act(() => {
    for (let index = 0; index < 8; ++index)
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
  })
  expect(get).toHaveBeenCalledTimes(1)
  await act(async () => finish(off))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('status')).toHaveTextContent('61234')
})

test('initial proxy status failure can be retried without reopening the page', async () => {
  const api = {
    getProxySettings: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(off),
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  await screen.findByRole('alert')
  expect(screen.getByTestId('plugins-auto-proxy-switch')).toBeDisabled()
  await userEvent.click(screen.getByTestId('plugins-auto-proxy-retry'))
  await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
})

test('language changes preserve a pending write and its response', async () => {
  const { default: i18n } = await import('@/i18n')
  const original = i18n.language
  let finish!: (value: PluginProxySettings) => void
  const configure = vi.fn(
    () =>
      new Promise<PluginProxySettings>(resolve => {
        finish = resolve
      })
  )
  const api = {
    getProxySettings: vi.fn().mockResolvedValue(off),
    configureAutoProxy: configure,
  } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const toggle = screen.getByTestId('plugins-auto-proxy-switch')
  await waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  try {
    await act(async () => {
      await i18n.changeLanguage(original === 'en' ? 'zh-CN' : 'en')
    })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await act(async () =>
      finish({
        ...off,
        autoDetect: true,
        status: 'detected',
        detectedUrl: 'http://127.0.0.1:61234',
      })
    )
    expect(toggle).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('61234')
    expect(configure).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(original)
    })
  }
})


test('a proxy status timeout does not claim that the target is disconnected', async () => {
  const api = { getProxySettings: vi.fn().mockRejectedValue(
    new GatewayRpcTimeoutError('plugin/proxy/status', 1, 'fixture-target')
  ) } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/读取超时|read timed out/)
  expect(alert).not.toHaveTextContent(/连接不可用|disconnected/)
  expect(api.getProxySettings).toHaveBeenCalledTimes(1)
})

test('a proxy write timeout reports an unknown outcome without replay', async () => {
  const configure = vi.fn().mockRejectedValue(
    new GatewayRpcTimeoutError('plugin/proxy/configure', 1, 'fixture-target')
  )
  const api = { getProxySettings: vi.fn().mockResolvedValue(off), configureAutoProxy: configure } as unknown as LocalCodexPluginApi
  render(<PluginProxyControl api={api} />)
  const control = await screen.findByTestId('plugins-auto-proxy-switch')
  await waitFor(() => expect(control).toBeEnabled())
  await userEvent.click(control)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/结果尚未确认|outcome is unconfirmed/)
  expect(alert).not.toHaveTextContent(/连接不可用|disconnected/)
  expect(configure).toHaveBeenCalledTimes(1)
})

test('same-turn catalog notices issue one proxy status RPC after dispatch admission', async () => {
  rpc.mockReset().mockResolvedValue(off)
  const api = createKCoderPluginApi({} as LocalCodexPluginApi, {
    deviceId: 'owned-proxy-target', workspacePath: '/owned/proxy-workspace',
  })
  const page = render(<PluginProxyControl api={api} />)
  try {
    await waitFor(() => expect(screen.getByTestId('plugins-auto-proxy-switch')).toBeEnabled())
    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => {
      for (let index = 0; index < 100; index++)
        window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    })
    expect(rpc).toHaveBeenCalledTimes(2)
    for (const [method, params] of rpc.mock.calls) {
      expect(method).toBe('runtime.plugins.request')
      expect(params).toEqual({ deviceId: 'owned-proxy-target', workspacePath: '/owned/proxy-workspace',
        method: 'plugin/proxy/status', params: {} })
    }
    act(() => { window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')); page.unmount() })
    await act(async () => {})
    expect(rpc).toHaveBeenCalledTimes(2)
  } finally { page.unmount() }
})


test('proxy diagnostics ignore unrelated target invalidations but retain own and unscoped refreshes', async () => {
  const read = vi.fn().mockResolvedValue(off)
  const api = { getProxySettings: read } as unknown as LocalCodexPluginApi
  const page = render(<PluginProxyControl api={api} deviceId="owned-target" />)
  try {
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 40; i++) await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'other-target' } }))
    })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'owned-target' } }))
    })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated')) })
    expect(read).toHaveBeenCalledTimes(3)
  } finally { page.unmount() }
})
