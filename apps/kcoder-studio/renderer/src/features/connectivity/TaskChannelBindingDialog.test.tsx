import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChannelRequestError } from '@/kcoder/channels'
import { channelFixture, channelTarget } from '@/kcoder/channels.test-fixtures'
import { TaskBindingPicker } from './TaskChannelBindingDialog'
import { invalidateChannelBindings } from '@/kcoder/channelBindingEvents'

const api = vi.hoisted(() => ({ read: vi.fn(), act: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelInventory: api.read, channelAction: api.act }))
let page = channelFixture()
beforeEach(() => {
  page = channelFixture(); api.read.mockImplementation(async () => structuredClone(page)); api.act.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
async function selectChat() {
  await screen.findByText('chatTasks.noCurrentBinding')
  fireEvent.change(screen.getByRole('combobox', { name: 'chatTasks.connection' }), { target: { value: 'connection' } })
  fireEvent.click(await screen.findByRole('radio'))
}

test('a binding changed in another client refreshes the picker without a polling tick', async () => {
  render(<TaskBindingPicker target={channelTarget} />)
  await screen.findByText('chatTasks.noCurrentBinding')
  page.chats[0].bindingRevision = 1
  page.chats[0].binding = { chatId: page.chats[0].id, target: channelTarget, revision: 1 }
  act(() => invalidateChannelBindings('gateway-channels'))
  await waitFor(() => expect(screen.queryByText('chatTasks.noCurrentBinding')).not.toBeInTheDocument())
  expect(api.read).toHaveBeenCalledTimes(2)
})

test.each([false, true])('picker foreground hints join the read; binding changes still reconcile (changed=%s)', async changed => {
  const original = structuredClone(page)
  let settle!: (value: ReturnType<typeof channelFixture>) => void
  api.read.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  render(<TaskBindingPicker target={channelTarget} />)
  fireEvent(document, new Event('visibilitychange'))
  if (changed) {
    page.chats[0].bindingRevision = 1
    page.chats[0].binding = { chatId: page.chats[0].id, target: channelTarget, revision: 1 }
    act(() => { invalidateChannelBindings('gateway-channels'); invalidateChannelBindings('gateway-channels') })
  }
  await act(async () => { settle(original) })
  expect(api.read).toHaveBeenCalledTimes(changed ? 2 : 1)
  expect(screen.queryByText('chatTasks.noCurrentBinding') !== null).toBe(!changed)
})

test('a picker mounted in a hidden tab waits for visibility before reading inventory', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  try {
    render(<TaskBindingPicker target={channelTarget} />)
    await act(async () => {})
    expect(api.read).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(api.read).toHaveBeenCalledOnce())
  } finally { visibility.mockRestore() }
})

test('a picker defers a pending binding-change reconciliation while its tab is hidden', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let settle!: (value: ReturnType<typeof channelFixture>) => void
  api.read.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  try {
    render(<TaskBindingPicker target={channelTarget} />)
    act(() => invalidateChannelBindings('gateway-channels'))
    visibility.mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { settle(structuredClone(page)) })
    expect(api.read).toHaveBeenCalledOnce()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2))
  } finally { visibility.mockRestore() }
})

test.each(['feishu', 'qq', 'weixin'] as const)('%s binds an observed chat directly to the original task without an authorization step', async platform => {
  page = channelFixture(platform)
  render(<TaskBindingPicker target={channelTarget} />)
  await selectChat()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.bindTask' }))
  await waitFor(() => expect(api.act).toHaveBeenCalledOnce())
  expect(api.act.mock.calls[0][0]).toEqual({ action: 'bind', chatId: 'observed-chat', target: channelTarget, expectedBindingRevision: 0 })
})

test('a bound chat can be unbound from this dialog, with its current revision and no member permission flow', async () => {
  page.chats[0].bindingRevision = 7
  page.chats[0].binding = { chatId: 'observed-chat', target: channelTarget, revision: 7 }
  render(<TaskBindingPicker target={channelTarget} action="unbind" />)
  fireEvent.click(await screen.findByRole('button', { name: 'chatTasks.unbind' }))
  expect(api.act).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.confirm' }))
  await waitFor(() => expect(api.act).toHaveBeenCalledOnce())
  expect(api.act.mock.calls[0][0]).toEqual({ action: 'unbind', chatId: 'observed-chat', expectedBindingRevision: 7 })
})

test('switching a chat from another task requires confirmation and the observed revision', async () => {
  page.chats[0].bindingRevision = 4
  page.chats[0].binding = { chatId: 'observed-chat', target: { ...channelTarget, threadId: 'previous-task' }, revision: 4 }
  render(<TaskBindingPicker target={channelTarget} />)
  await selectChat()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.bindTask' }))
  expect(api.act).not.toHaveBeenCalled()
  expect(screen.getByText('chatTasks.switchConfirm')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.confirm' }))
  await waitFor(() => expect(api.act).toHaveBeenCalledOnce())
  expect(api.act.mock.calls[0][0].expectedBindingRevision).toBe(4)
})

test('unknown binding results offer refresh and never automatically repeat the mutation', async () => {
  api.act.mockRejectedValue(new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', true))
  render(<TaskBindingPicker target={channelTarget} />)
  await selectChat()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.bindTask' }))
  await screen.findByText('chatTasks.unconfirmed')
  fireEvent.click(screen.getByRole('button', { name: 'octop.refresh' }))
  await waitFor(() => expect(api.read.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(api.act).toHaveBeenCalledOnce()
})

test('chat pages are scrollable and a task can show multiple original chat bindings', async () => {
  page.chats = Array.from({ length: 12 }, (_, index) => ({ ...page.chats[0], id: `chat-${index}`,
    label: `Observed chat ${index}`, range: { ...page.chats[0].range, chatId: `platform-${index}` } }))
  for (const row of page.chats.slice(0, 2)) { row.bindingRevision = 1; row.binding = { chatId: row.id, target: channelTarget, revision: 1 } }
  render(<TaskBindingPicker target={channelTarget} />)
  expect(await screen.findAllByRole('button', { name: 'chatTasks.unbind' })).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox', { name: 'chatTasks.connection' }), { target: { value: 'connection' } })
  expect(screen.getAllByRole('radio')).toHaveLength(10)
  expect(screen.getAllByRole('radio')[0].parentElement?.parentElement).toHaveClass('overflow-y-auto')
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.next' }))
  expect(screen.getAllByRole('radio')).toHaveLength(2)
})

test('current reply delivery states and unknown outcome stay visible without a resend action', async () => {
  page.chats[0].bindingRevision = 1
  page.chats[0].binding = { chatId: 'observed-chat', target: channelTarget, revision: 1 }
  page.chats[0].deliveries = [{ deliveryId: 'one', deliveryState: 'unknown', phase: 'result', code: 'CHANNEL_WORKER_TIMEOUT' }]
  render(<TaskBindingPicker target={channelTarget} />)
  await screen.findByTestId('task-delivery-unconfirmed-hint')
  expect(screen.getByTestId('task-delivery-code')).toHaveTextContent('CHANNEL_WORKER_TIMEOUT')
  expect(screen.getByTestId('task-delivery-list').querySelectorAll('button')).toHaveLength(0)
})
