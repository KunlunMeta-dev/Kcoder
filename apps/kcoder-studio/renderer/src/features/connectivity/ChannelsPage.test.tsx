import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { channelFixture } from '@/kcoder/channels.test-fixtures'
import { ChannelsPage } from './ChannelsPage'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { RetainedPage } from '@/components/layout/retainedPages'
import { invalidateChannelBindings } from '@/kcoder/channelBindingEvents'
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

test('channel notifications refresh visible pages; retained hidden pages wait until reopened', async () => {
  const view = render(<RetainedPage open={false}><ChannelsPage /></RetainedPage>)
  await act(async () => {})
  expect(fixture.read).not.toHaveBeenCalled()
  view.rerender(<RetainedPage open><ChannelsPage /></RetainedPage>)
  await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce())
  page.connections[0].label = 'Changed by another client'
  act(() => invalidateChannelBindings('gateway-channels'))
  await screen.findByText('Changed by another client')
  expect(fixture.read).toHaveBeenCalledTimes(2)
  view.rerender(<RetainedPage open={false}><ChannelsPage /></RetainedPage>)
  act(() => invalidateChannelBindings('gateway-channels'))
  expect(fixture.read).toHaveBeenCalledTimes(2)
  view.rerender(<RetainedPage open><ChannelsPage /></RetainedPage>)
  await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(3))
})

test.each([false, true])('foreground events join the channel read; only binding changes need a trailing read (changed=%s)', async changed => {
  let settle!: (value: ReturnType<typeof channelFixture>) => void
  const original = structuredClone(page)
  fixture.read.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  render(<ChannelsPage />)
  fireEvent(document, new Event('visibilitychange'))
  fireEvent(window, new Event('focus'))
  if (changed) {
    page.connections[0].label = 'Latest saved connection'
    act(() => { invalidateChannelBindings('gateway-channels'); invalidateChannelBindings('gateway-channels') })
  }
  await act(async () => { settle(original) })
  expect(fixture.read).toHaveBeenCalledTimes(changed ? 2 : 1)
  if (changed) expect(screen.getByText('Latest saved connection')).toBeInTheDocument()
})

test('a hidden tab defers the initial channel inventory until it becomes visible', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  try {
    render(<ChannelsPage />)
    await act(async () => {})
    expect(fixture.read).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce())
  } finally { visibility.mockRestore() }
})

test('a binding change cannot start a trailing channel read after the tab hides', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let settle!: (value: ReturnType<typeof channelFixture>) => void
  fixture.read.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  try {
    render(<ChannelsPage />)
    act(() => invalidateChannelBindings('gateway-channels'))
    visibility.mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { settle(structuredClone(page)) })
    expect(fixture.read).toHaveBeenCalledOnce()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2))
  } finally { visibility.mockRestore() }
})


test('a running connection can be renamed without disconnecting or rewriting credentials', async () => {
  fixture.act.mockImplementation(async body => { page.connections[0].label = body.label; page.connections[0].revision++; return page.connections[0] })
  render(<ChannelsPage />)
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
  render(<ChannelsPage />)
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
  render(<WorkbenchContext.Provider value={{ openRuntimeTask: open } as unknown as WorkbenchContextValue}><ChannelsPage /></WorkbenchContext.Provider>)
  await revealConnection(); expect(fixture.details).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /chatTasks.observedChats/ }))
  await screen.findByText('Fix login')
  expect(screen.getByText('Mac mini › Project Alpha')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'channelPresentation.openTask' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ deviceId: 'macmini', taskId: 'kcoder:macmini:original-session', threadId: 'original-session', workspacePath: target.workspacePath, runtimeHandle: { threadId: 'original-session' } }))
})

test('settings use the Gateway manager without a target scope, Native enable switch or backend restart', async () => {
  render(<ChannelsPage />)
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
  render(<WorkbenchContext.Provider value={{ openRuntimeTask: vi.fn() } as unknown as WorkbenchContextValue}><ChannelsPage /></WorkbenchContext.Provider>)
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
  render(<ChannelsPage />)
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
  render(<ChannelsPage />)
  await revealConnection()
  const toggle = screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  expect(fixture.act).toHaveBeenCalledWith({ action: 'settings', settings: { mirrorClientTurns: true } }, expect.any(AbortSignal))
  cleanup()
  render(<ChannelsPage />)
  await revealConnection()
  expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).not.toBeChecked())
  expect(fixture.native).not.toHaveBeenCalled()
})

test('an unconfirmed settings save keeps the confirmed switch and reports the unknown outcome', async () => {
  const { ChannelRequestError } = await import('@/kcoder/channels')
  fixture.act.mockRejectedValue(new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', true))
  render(<ChannelsPage />)
  await revealConnection()
  fireEvent.click(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' }))
  await screen.findByText('gatewayChannels.operationUnknown')
  expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).not.toBeChecked()
  expect(fixture.act).toHaveBeenCalledOnce()
})

test.each([false, true])('an unconfirmed publication requires an explicit observation and never rolls back or retries (before=%s)', async before => {
  const { ChannelRequestError } = await import('@/kcoder/channels')
  page.settings.mirrorClientTurns = before
  fixture.act.mockImplementationOnce(async body => {
    page.settings.mirrorClientTurns = body.settings.mirrorClientTurns
    throw new ChannelRequestError('CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED')
  })
  render(<ChannelsPage />)
  await revealConnection()
  const toggle = screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })
  fireEvent.click(toggle)
  await screen.findByText('gatewayChannels.settingsPublicationUnconfirmed')
  expect(toggle).toBeDisabled()
  expect(toggle).toHaveAttribute('aria-checked', String(before))
  expect(screen.queryByText('octop.failed')).not.toBeInTheDocument()
  fireEvent.click(toggle)
  expect(fixture.act).toHaveBeenCalledOnce()
  const reads = fixture.read.mock.calls.length
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => expect(fixture.read.mock.calls.length).toBeGreaterThan(reads))
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', String(!before)))
  expect(toggle).toBeDisabled()
  expect(screen.getByText('gatewayChannels.settingsPublicationUnconfirmed')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'octop.refresh' }))
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(screen.getByText('gatewayChannels.settingsPublicationUnconfirmed')).toBeInTheDocument()
  expect(fixture.act).toHaveBeenCalledOnce()
  fixture.act.mockImplementationOnce(async body => { page.settings = { ...page.settings, ...body.settings }; return structuredClone(page.settings) })
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', String(before)))
  await waitFor(() => expect(screen.queryByText('gatewayChannels.settingsPublicationUnconfirmed')).not.toBeInTheDocument())
  expect(fixture.act).toHaveBeenCalledTimes(2)
})

test('a failed explicit observation keeps publication uncertainty and cannot enable another mutation', async () => {
  const { ChannelRequestError } = await import('@/kcoder/channels')
  fixture.act.mockRejectedValue(new ChannelRequestError('CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED'))
  render(<ChannelsPage />)
  await revealConnection()
  fireEvent.click(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' }))
  await screen.findByText('gatewayChannels.settingsPublicationUnconfirmed')
  fixture.read.mockRejectedValueOnce(new Error('PRIVATE_READ_PATH_CANARY'))
  fireEvent.click(screen.getByRole('button', { name: 'octop.refresh' }))
  await screen.findByText('octop.readFailed')
  expect(screen.getByText('gatewayChannels.settingsPublicationUnconfirmed')).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })).toBeDisabled()
  expect(document.body.textContent).not.toContain('CANARY')
  expect(fixture.act).toHaveBeenCalledOnce()
})

test('a definite pre-publication settings rejection keeps the prior observation and remains editable', async () => {
  const { ChannelRequestError } = await import('@/kcoder/channels')
  fixture.act.mockRejectedValue(new ChannelRequestError('CHANNEL_SETTINGS_INVALID'))
  render(<ChannelsPage />)
  await revealConnection()
  const toggle = screen.getByRole('switch', { name: 'gatewayChannels.clientSync' })
  fireEvent.click(toggle)
  await screen.findByText('octop.failed')
  expect(toggle).not.toBeChecked()
  expect(toggle).not.toBeDisabled()
  expect(screen.queryByText('gatewayChannels.settingsPublicationUnconfirmed')).not.toBeInTheDocument()
  expect(fixture.act).toHaveBeenCalledOnce()
})

test('removing a stopped credentialed connection needs only confirmation and the observed connection revision', async () => {
  page.connections[0].enabled = false; page.connections[0].state = 'stopped'
  render(<ChannelsPage />)
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
  render(<ChannelsPage />)
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
  render(<ChannelsPage />)
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
  render(<ChannelsPage />)
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

test('hiding a retained channel page pauses observation without cancelling an issued user operation', async () => {
  let finish!: (value: unknown) => void
  fixture.act.mockImplementation(body => body.action === 'disconnect'
    ? new Promise(resolve => { finish = resolve }) : Promise.resolve({}))
  const disconnects = () => fixture.act.mock.calls.filter(([body]) => body.action === 'disconnect')
  const view = render(<RetainedPage open><ChannelsPage /></RetainedPage>)
  await revealConnection()
  fireEvent.click(screen.getByRole('button', { name: 'connections.stop' }))
  await waitFor(() => expect(disconnects()).toHaveLength(1))
  const signal = disconnects()[0][1] as AbortSignal
  view.rerender(<RetainedPage open={false}><ChannelsPage /></RetainedPage>)
  expect(signal.aborted).toBe(false)
  await act(async () => finish({}))
  expect(disconnects()).toHaveLength(1)
  view.unmount()
  expect(signal.aborted).toBe(true)
})

test('ingress confirmation diagnostics remain in the existing collapsed details without changing connected state', async () => {
  Object.assign(page.connections[0], { reasonCode: 'CHANNEL_INGRESS_FAILED' })
  render(<ChannelsPage />)
  await revealConnection()
  const mutationsBeforeDetails = fixture.act.mock.calls.length
  const panel = screen.getByTestId('channel-connection-diagnostics')
  expect(panel).not.toHaveAttribute('open')
  expect(within(panel).getByTestId('channel-ingress-diagnostic')).not.toBeVisible()
  expect(screen.getAllByText('connections.state.connected').length).toBeGreaterThan(0)
  fireEvent.click(within(panel).getByText('octop.diagnostics'))
  expect(within(panel).getByText('gatewayChannels.ingressUnconfirmed')).toBeVisible()
  expect(within(panel).getByText('CHANNEL_INGRESS_FAILED')).toBeVisible()
  expect(fixture.act).toHaveBeenCalledTimes(mutationsBeforeDetails)
  expect(document.body.textContent).not.toContain('PRIVATE_REASON_CANARY')
})

test('an unapproved reason injected past the transport parser cannot appear in connection diagnostics', async () => {
  Object.assign(page.connections[0], { reasonCode: 'PRIVATE_REASON_CANARY' })
  render(<ChannelsPage />)
  await revealConnection()
  const panel = screen.getByTestId('channel-connection-diagnostics')
  fireEvent.click(within(panel).getByText('octop.diagnostics'))
  expect(within(panel).queryByTestId('channel-ingress-diagnostic')).not.toBeInTheDocument()
  expect(document.body.textContent).not.toContain('PRIVATE_REASON_CANARY')
})

test('published Weixin checkpoint diagnostics remain visible without claiming an ingress rejection', async () => {
  page.connections[0].platform = 'weixin'
  page.chats[0].range.platform = 'weixin'
  Object.assign(page.connections[0], { reasonCode: 'WEIXIN_CHECKPOINT_FAILED' })
  render(<ChannelsPage />)
  await revealConnection()
  const panel = screen.getByTestId('channel-connection-diagnostics')
  fireEvent.click(within(panel).getByText('octop.diagnostics'))
  expect(within(panel).getByText('gatewayChannels.connectionObservationUnconfirmed')).toBeVisible()
  expect(within(panel).getByText('WEIXIN_CHECKPOINT_FAILED')).toBeVisible()
  expect(within(panel).queryByText('gatewayChannels.ingressUnconfirmed')).not.toBeInTheDocument()
})
