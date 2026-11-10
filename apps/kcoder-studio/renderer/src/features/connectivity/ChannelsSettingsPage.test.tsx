import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { channelFixture } from '@/kcoder/channels.test-fixtures'
import { ChannelsSettingsPage } from './ChannelsSettingsPage'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
const fixture = vi.hoisted(() => ({ read: vi.fn(), act: vi.fn(), native: vi.fn(), details: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/octop/OctopSurface', () => ({
  OctopSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  OctopPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelInventory: fixture.read, channelAction: fixture.act, channelChatDetails: fixture.details }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.native }))
let page = channelFixture()
beforeEach(() => { page = channelFixture(); fixture.read.mockImplementation(async () => structuredClone(page)); fixture.act.mockResolvedValue({}); fixture.details.mockResolvedValue({ chatId: page.chats[0].id, bindingRevision: 0, messages: [], bindingInfo: null }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })
async function revealConnection() {
  const row = await screen.findByTestId('channel-connection-instance')
  const group = row.closest('[data-testid="channel-platform-group"]')!
  if (!group.hasAttribute('open')) fireEvent.click(group.querySelector(':scope > summary')!)
  if (!row.hasAttribute('open')) fireEvent.click(row.querySelector(':scope > summary')!)
}


test('a running connection can be renamed without disconnecting or rewriting credentials', async () => {
  fixture.act.mockImplementation(async body => { page.connections[0].label = body.label; page.connections[0].revision++; return page.connections[0] })
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByRole('button', { name: 'channelPresentation.rename' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'channelPresentation.rename' }), { target: { value: 'My development bot' } })
  fireEvent.click(screen.getByRole('button', { name: 'octop.save' }))
  await screen.findByText('My development bot')
  expect(fixture.act).toHaveBeenCalledWith({ action: 'rename_connection', connectionId: 'connection', label: 'My development bot', expectedRevision: 1 }, expect.any(AbortSignal))
  expect(fixture.act).toHaveBeenCalledOnce()
})

test('chats show searchable incoming content, and an explicit alias persists across inventory refresh', async () => {
  page.chats[0].lastMessage = { text: 'Please start this project', senderId: 'user-1', senderName: '', timestampMs: 1000, attachments: [] }
  fixture.act.mockImplementation(async body => { page.chats[0].alias = body.alias; page.chats[0].aliasRevision = 1; return page.chats[0] })
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByRole('button', { name: /chatTasks.observedChats/ }))
  expect(await screen.findByText('Please start this project')).toBeInTheDocument()
  expect(fixture.details).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'channelPresentation.search' }), { target: { value: 'missing' } })
  expect(screen.getByText('channelPresentation.noMatches')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'channelPresentation.search' }), { target: { value: 'start this' } })
  fireEvent.click(screen.getByRole('button', { name: 'channelPresentation.editAlias' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'channelPresentation.editAlias' }), { target: { value: 'My phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'octop.save' }))
  await screen.findByText('My phone')
  expect(fixture.act).toHaveBeenCalledWith({ action: 'rename_chat', chatId: 'observed-chat', alias: 'My phone', expectedAliasRevision: 0 }, expect.any(AbortSignal))
  expect(fixture.native).not.toHaveBeenCalled()
})

test('a bound chat reads its title only on expansion and opens the exact original target and workspace', async () => {
  const target = { serverId: 'macmini', workspacePath: '/Users/Admin/Project Alpha', threadId: 'original-session' }
  page.chats[0].bindingRevision = 2
  page.chats[0].binding = { chatId: page.chats[0].id, target, revision: 2 }
  fixture.details.mockResolvedValue({ chatId: page.chats[0].id, bindingRevision: 2, messages: [], bindingInfo: { revision: 2, status: 'available', title: 'Fix login', serverLabel: 'Mac mini' } })
  const open = vi.fn().mockResolvedValue(undefined)
  render(<WorkbenchContext.Provider value={{ openRuntimeTask: open } as unknown as WorkbenchContextValue}><ChannelsSettingsPage /></WorkbenchContext.Provider>)
  await revealConnection(); expect(fixture.details).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /chatTasks.observedChats/ }))
  await screen.findByText('Fix login')
  expect(screen.getByText('Mac mini › Project Alpha')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'channelPresentation.openTask' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ deviceId: 'macmini', taskId: 'kcoder:macmini:original-session', threadId: 'original-session', workspacePath: target.workspacePath, runtimeHandle: { threadId: 'original-session' } }))
})

test('settings use the Gateway manager without a target scope, Native enable switch or backend restart', async () => {
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByTestId('channel-add-connection'))
  expect(screen.getByTestId('channel-add-connection-qq')).toBeEnabled()
  expect(screen.getByTestId('channel-add-connection-weixin')).toBeEnabled()
  expect(fixture.native).not.toHaveBeenCalled()
  expect(fixture.act).not.toHaveBeenCalled()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
})

test.each(['CHANNEL_TASK_WORKSPACE_MISMATCH', 'CHANNEL_TASK_REQUEST_UNKNOWN'])('a failed bound target displays its known location and an accurate status (%s)', async code => {
  page.chats[0].bindingRevision = 2
  page.chats[0].binding = { chatId: page.chats[0].id, revision: 2,
    target: { serverId: 'original-target', workspacePath: '/old/workspace', threadId: 'old-thread' } }
  fixture.details.mockResolvedValue({ chatId: page.chats[0].id, bindingRevision: 2, messages: [],
    bindingInfo: { revision: 2, status: 'unavailable', code } })
  render(<WorkbenchContext.Provider value={{ openRuntimeTask: vi.fn() } as unknown as WorkbenchContextValue}><ChannelsSettingsPage /></WorkbenchContext.Provider>)
  await revealConnection()
  fireEvent.click(screen.getByRole('button', { name: /chatTasks.observedChats/ }))
  const mismatch = code === 'CHANNEL_TASK_WORKSPACE_MISMATCH'
  await screen.findByText(mismatch ? 'channelPresentation.workspaceMismatch' : 'channelPresentation.targetUnavailable')
  expect(screen.getByText(mismatch ? 'channelPresentation.workspaceMismatchShort' : 'channelPresentation.targetUnavailableShort')).toBeInTheDocument()
  expect(screen.getByText(/\/old\/workspace/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'channelPresentation.rebind' })).toBeEnabled()
  expect(screen.queryByText('chatTasks.bindingState.active')).not.toBeInTheDocument()
  if (mismatch) expect(screen.getByRole('button', { name: 'channelPresentation.openTask' })).toBeDisabled()
  else expect(screen.queryByText('channelPresentation.workspaceMismatch')).not.toBeInTheDocument()
})

test('a new QQ form remains unsaved on opening and closing', async () => {
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByTestId('channel-add-connection'))
  fireEvent.click(screen.getByTestId('channel-add-connection-qq'))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: 'octop.manual' }))
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'gatewayChannels.identity.qq' }), { target: { value: 'fixture-app' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'octop.cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(fixture.act.mock.calls.every(([body]) =>
    body.action === 'authorization_begin' || body.action === 'authorization_cancel')).toBe(true)
})

test('the shared client-sync switch defaults off and persists a single Gateway-wide setting', async () => {
  fixture.act.mockImplementation(async body => {
    page.settings = body.settings
    return body.settings
  })
  render(<ChannelsSettingsPage />)
  await revealConnection()
  const toggle = screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  expect(fixture.act).toHaveBeenCalledWith({ action: 'settings', settings: { mirrorClientTurns: true } }, expect.any(AbortSignal))
  cleanup()
  render(<ChannelsSettingsPage />)
  await revealConnection()
  expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).not.toBeChecked())
  expect(fixture.native).not.toHaveBeenCalled()
})

test('an unconfirmed settings save keeps the confirmed switch and reports the unknown outcome', async () => {
  const { ChannelRequestError } = await import('@/kcoder/channels')
  fixture.act.mockRejectedValue(new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', true))
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' }))
  await screen.findByText('gatewayChannels.operationUnknown')
  expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).not.toBeChecked()
  expect(fixture.act).toHaveBeenCalledOnce()
})

test('removing a stopped credentialed connection needs only confirmation and the observed connection revision', async () => {
  page.connections[0].enabled = false; page.connections[0].state = 'stopped'
  render(<ChannelsSettingsPage />)
  await revealConnection()
  fireEvent.click(screen.getByTestId('channel-remove-connection'))
  const tooltip = await screen.findByRole('tooltip')
  expect(fixture.act).not.toHaveBeenCalled()
  fireEvent.click(within(tooltip).getByRole('button', { name: 'connections.remove' }))
  await waitFor(() => expect(fixture.act).toHaveBeenCalledOnce())
  expect(fixture.act.mock.calls[0][0]).toEqual({ action: 'remove', connectionId: 'connection', expectedRevision: 1 })
  expect(fixture.native).not.toHaveBeenCalled()
})


test('execution restrictions are a collapsed read-only notice below connection groups', async () => {
  page.settings.toolRestrictions = { enabled: true, disabledTools: ['AskUserQuestion', 'WebSearch'] }
  render(<ChannelsSettingsPage />)
  const panel = await screen.findByTestId('channel-tool-restrictions')
  expect(panel).not.toHaveAttribute('open')
  expect(within(panel).queryByRole('switch')).not.toBeInTheDocument()
  expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(panel).queryByRole('button')).not.toBeInTheDocument()
  fireEvent.click(panel.querySelector('summary')!)
  expect(panel).toHaveAttribute('open')
  expect(within(panel).getByText('AskUserQuestion')).toBeInTheDocument()
  expect(within(panel).getByText('WebSearch')).toBeInTheDocument()
  expect(screen.getByTestId('channel-connection-groups').compareDocumentPosition(screen.getByTestId('channel-global-settings')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(fixture.act).not.toHaveBeenCalled()
})

test.each([false, true])('inactive or empty restrictions show no extra tools blocked (enabled=%s)', async enabled => {
  page.settings.toolRestrictions = { enabled, disabledTools: enabled ? [] : ['AskUserQuestion'] }
  render(<ChannelsSettingsPage />)
  const panel = await screen.findByTestId('channel-tool-restrictions')
  expect(panel.querySelector('summary')).toHaveTextContent('gatewayChannels.toolRestrictionsNone')
  fireEvent.click(panel.querySelector('summary')!)
  expect(within(panel).queryByRole('list')).not.toBeInTheDocument()
  expect(within(panel).getByText('gatewayChannels.toolRestrictionsApproval')).toBeInTheDocument()
  expect(fixture.act).not.toHaveBeenCalled()
})

test('connections form collapsed platform and instance layers, with a separate add-platform picker', async () => {
  const original = page.connections[0]
  page.connections.push({ ...original, id: 'second', label: 'Second bot' }, { ...original, id: 'qq', platform: 'qq', label: 'QQ bot' })
  render(<ChannelsSettingsPage />)
  const groups = await screen.findAllByTestId('channel-platform-group')
  expect(groups).toHaveLength(2)
  for (const group of groups) expect(group).not.toHaveAttribute('open')
  for (const row of screen.getAllByTestId('channel-connection-instance')) expect(row).not.toHaveAttribute('open')
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  expect(fixture.details).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('channel-add-connection'))
  expect(await screen.findByTestId('channel-add-connection-qq')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('channel-add-connection-qq'))
  await waitFor(() => expect(fixture.act).toHaveBeenCalledOnce())
  expect(fixture.act).toHaveBeenCalledWith(expect.objectContaining({
    action: 'authorization_begin', platform: 'qq', expectedRevision: 0,
  }), expect.any(AbortSignal))
})
