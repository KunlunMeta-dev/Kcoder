import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChannelRequestError } from '@/kcoder/channels'
import { ChannelConnectionEditor } from './ChannelConnectionEditor'
import { channelPlatforms } from '@/kcoder/channelPlatforms'

const api = vi.hoisted(() => ({ save: vi.fn(), connectionId: '' }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelAction: api.save }))
vi.mock('./ChannelAuthentication', () => ({ ChannelAuthentication: ({ connectionId, onChange }: {
  connectionId: string; onChange: (value: { state: string; flowId: string }) => void
}) => <button onClick={() => { api.connectionId = connectionId; onChange({ state: 'ready', flowId: 'original-verified-flow' }) }}>Verify scan</button> }))

beforeEach(() => {
  api.save.mockImplementation(async body => ({ state: 'saved', flowId: body.flowId, connection: { id: api.connectionId, revision: 1 } }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

test.each(['qq', 'wecom', 'dingtalk', 'github'] as const)('%s manual form uses the same identity and credential fields as backend validation', async platform => {
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform={platform} onClose={vi.fn()} onSaved={saved} />)
  if (channelPlatforms[platform].authentication === 'qr') fireEvent.click(screen.getByText('octop.manual'))
  fireEvent.change(screen.getByLabelText(`gatewayChannels.identity.${platform}`), { target: { value: 'fixture-identity' } })
  fireEvent.change(screen.getByLabelText(`gatewayChannels.secret.${platform}`), { target: { value: 'fixture-private' } })
  if (platform === 'github') fireEvent.change(screen.getByLabelText('gatewayChannels.repositories'), { target: { value: 'owner/repo' } })
  fireEvent.click(screen.getByRole('button', { name: 'octop.save' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  const definition = channelPlatforms[platform], body = api.save.mock.calls[0][0]
  expect(body.action).toBe('save')
  expect(body.connection.configuration[definition.identityField]).toBe('fixture-identity')
  expect(body.connection.configuration[definition.credentialField]).toBeUndefined()
  expect(body.credentials).toEqual({ [definition.credentialField]: 'fixture-private' })
})

test.each([null, 'https://ilink.b.qq.com'])('manual Weixin save defaults a missing endpoint and preserves an explicit one: %s', async apiBase => {
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform="weixin" onClose={vi.fn()} onSaved={saved}
    connection={{ id: 'existing-weixin', platform: 'weixin', label: 'Weixin', revision: 1, enabled: false,
      state: 'stopped', hasCredential: true, configuration: { accountId: 'fixture-account', apiBase } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'octop.save' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save.mock.calls[0][0].connection.configuration.apiBase).toBe(apiBase ?? 'https://ilinkai.weixin.qq.com')
  expect(api.save.mock.calls[0][0].credentials).toBeUndefined()
})

test.each(['feishu', 'weixin', 'wecom', 'dingtalk', 'qq'] as const)('%s saves exactly once after scan verification without a Save click', async platform => {
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform={platform} onClose={vi.fn()} onSaved={saved} />)
  expect(screen.queryByRole('button', { name: 'octop.save' })).not.toBeInTheDocument()
  expect(api.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledOnce()
  expect(api.save.mock.calls[0][0]).toMatchObject({ action: 'authorization_commit', flowId: 'original-verified-flow' })
  expect(api.save.mock.calls[0][0].label.trim()).not.toBe('')
})

test('a lost save reply is reported without automatically committing the verified flow again', async () => {
  api.save.mockRejectedValue(new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', true))
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform="feishu" onClose={vi.fn()} onSaved={saved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  await screen.findByText('gatewayChannels.saveUnknown')
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  expect(api.save).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'gatewayChannels.retrySave' })).not.toBeInTheDocument()
})

test('a failed save can be explicitly retried with the same flow, and only a confirmed receipt closes the editor', async () => {
  api.save.mockRejectedValueOnce(new ChannelRequestError('CHANNEL_CONNECTION_STATE_CHANGED'))
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform="weixin" onClose={vi.fn()} onSaved={saved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  fireEvent.click(await screen.findByRole('button', { name: 'gatewayChannels.retrySave' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledTimes(2)
  expect(api.save.mock.calls.every(([body]) => body.flowId === 'original-verified-flow')).toBe(true)
})

test('closing an editor fences a late automatic save result from a newly opened peer editor', async () => {
  let finish!: (value: unknown) => void
  api.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const saved = vi.fn(), first = render(<ChannelConnectionEditor platform="feishu" onClose={vi.fn()} onSaved={saved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  const originalId = api.connectionId
  first.unmount()
  render(<ChannelConnectionEditor platform="weixin" onClose={vi.fn()} onSaved={vi.fn()} />)
  await act(async () => { finish({ state: 'saved', flowId: 'original-verified-flow', connection: { id: originalId, revision: 1 } }) })
  expect(saved).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('an unexpected save receipt is unknown and cannot be presented as a successful addition', async () => {
  api.save.mockResolvedValue({ state: 'saved', flowId: 'another-flow', connection: { id: 'another-connection', revision: 1 } })
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform="feishu" onClose={vi.fn()} onSaved={saved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  await screen.findByText('gatewayChannels.saveUnknown')
  expect(saved).not.toHaveBeenCalled()
})

test('scan confirmation commits this connection\'s selected features through the same save operation', async () => {
  const saved = vi.fn()
  render(<ChannelConnectionEditor platform="feishu" onClose={vi.fn()} onSaved={saved} />)
  fireEvent.click(screen.getByRole('switch', { name: 'channelFeatures.fields.showTyping' }))
  fireEvent.click(screen.getByRole('button', { name: 'Verify scan' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save.mock.calls[0][0].features).toMatchObject({ meta: { config_version: 1 }, showTyping: false, responseMode: 'final' })
})
