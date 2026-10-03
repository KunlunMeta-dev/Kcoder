import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { LocalCodexPluginApi, PluginProxySettings } from '@/api/local/codexPlugins'
import { PluginProxyControl } from './PluginProxyControl'

const off: PluginProxySettings = {
  autoDetect: false,
  configuredUrl: 'http://127.0.0.1:9000',
  detectedUrl: null,
  checkedPorts: 0,
  status: 'disabled',
}
test('one switch enables verified proxy selection and preserves manual fallback', async () => {
  const configure = vi
    .fn()
    .mockResolvedValue({
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
