import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChannelAction } from '@/kcoder/channels'
import { ChannelAuthentication } from './ChannelAuthentication'

const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelAction: api.request }))
afterEach(async () => { cleanup(); await Promise.resolve(); vi.clearAllMocks() })

for (const platform of ['feishu', 'weixin', 'wecom', 'dingtalk', 'qq'] as const) test(`${platform} shares the original flow, scan display and close cancellation`, async () => {
  api.request.mockImplementation(async (body: ChannelAction) => ({ flowId: 'flowId' in body ? body.flowId : '',
    state: 'waiting', intervalMs: 60000, verificationUrl: 'https://work.weixin.qq.com/fixture' }))
  const view = render(<ChannelAuthentication platform={platform} connectionId="new-connection" revision={0} onChange={vi.fn()} />)
  await screen.findByRole('status')
  expect(screen.getByRole('link', { name: 'gatewayChannels.openAuthentication' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByText(`gatewayChannels.authenticationHint.${platform}`)).toBeInTheDocument()
  const begin = api.request.mock.calls[0][0]
  expect(begin).toMatchObject({ action: 'authorization_begin', platform, connectionId: 'new-connection', expectedRevision: 0 })
  const recover = await screen.findByRole('button', { name: /octop.recover/ })
  await waitFor(() => expect(recover).toBeEnabled())
  fireEvent.click(recover)
  await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2))
  expect(api.request.mock.calls[1][0]).toEqual({ action: 'authorization_poll', flowId: begin.flowId })
  view.unmount()
  await waitFor(() => expect(api.request.mock.calls.at(-1)?.[0]).toEqual({ action: 'authorization_cancel', flowId: begin.flowId }))
  expect(api.request.mock.calls.some(([body]) => body.action === 'authorization_commit')).toBe(false)
})

test('a terminal QR offers explicit renewal with a new flow and clears the previous selection', async () => {
  api.request.mockImplementation(async (body: ChannelAction) => ({ flowId: 'flowId' in body ? body.flowId : '', state: 'expired' }))
  const changed = vi.fn()
  render(<ChannelAuthentication platform="wecom" connectionId="new-connection" revision={0} onChange={changed} />)
  await screen.findByText('gatewayChannels.authenticationState.expired')
  const first = api.request.mock.calls[0][0].flowId
  const renew = screen.getByRole('button', { name: /gatewayChannels.newAuthentication/ })
  await waitFor(() => expect(renew).toBeEnabled())
  await act(async () => { fireEvent.click(renew) })
  await waitFor(() => expect(api.request.mock.calls.filter(([body]) => body.action === 'authorization_begin')).toHaveLength(2))
  const next = api.request.mock.calls.filter(([body]) => body.action === 'authorization_begin')[1][0]
  expect(next.flowId).not.toBe(first)
  expect(changed).toHaveBeenCalledWith(null)
  expect(api.request.mock.calls.some(([body]) => body.action === 'authorization_cancel' && body.flowId === first)).toBe(true)
})

test('QR images use response metadata without a per-platform rendering branch', async () => {
  api.request.mockResolvedValue({ flowId: 'original', state: 'waiting', intervalMs: 60000,
    verificationKind: 'image', verificationUrl: 'data:image/png;base64,fixture' })
  render(<ChannelAuthentication platform="wecom" connectionId="new" revision={0} onChange={vi.fn()} />)
  expect(await screen.findByRole('img', { name: 'gatewayChannels.authenticationHint.wecom' })).toHaveAttribute('src', 'data:image/png;base64,fixture')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})
