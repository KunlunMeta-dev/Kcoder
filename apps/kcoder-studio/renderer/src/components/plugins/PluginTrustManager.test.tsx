import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { LocalCodexPluginApi, PluginTrustState } from '@/api/local/codexPlugins'
import { PluginTrustManager } from './PluginTrustManager'

const trusted: PluginTrustState = {
  entries: [
    { path: '/target/plugins', decision: 'trust', effective: 'trusted', source: 'explicit' },
  ],
  bypassActive: false,
}

test('requires explicit confirmation and presents the server result after revoke', async () => {
  const setTrust = vi
    .fn()
    .mockResolvedValue({
      entries: [{ ...trusted.entries[0], decision: 'revoke', effective: 'untrusted' }],
      bypassActive: false,
    })
  const api = {
    listTrust: vi.fn().mockResolvedValue(trusted),
    setTrust,
  } as unknown as LocalCodexPluginApi
  render(<PluginTrustManager api={api} target="remote-target" onClose={() => {}} />)
  expect(await screen.findByText('/target/plugins')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('plugin-trust-revoke'))
  expect(setTrust).not.toHaveBeenCalled()
  await userEvent.click(screen.getByTestId('plugin-trust-apply'))
  await waitFor(() => expect(setTrust).toHaveBeenCalledWith('/target/plugins', 'revoke'))
  expect(await screen.findByTestId('plugin-trust-trust')).toBeEnabled()
  expect(screen.queryByTestId('plugin-trust-confirm')).not.toBeInTheDocument()
})

test('failed mutation preserves the confirmation and never renders the remote error', async () => {
  const api = {
    listTrust: vi.fn().mockResolvedValue(trusted),
    setTrust: vi.fn().mockRejectedValue(new Error('secret-file-token')),
  } as unknown as LocalCodexPluginApi
  render(<PluginTrustManager api={api} target="remote-target" onClose={() => {}} />)
  await userEvent.click(await screen.findByTestId('plugin-trust-never'))
  await userEvent.click(screen.getByTestId('plugin-trust-apply'))
  expect(await screen.findByRole('alert')).not.toHaveTextContent('secret-file-token')
  expect(screen.getByTestId('plugin-trust-confirm')).toBeInTheDocument()
  expect(screen.getByTestId('plugin-trust-apply')).toBeEnabled()
})
