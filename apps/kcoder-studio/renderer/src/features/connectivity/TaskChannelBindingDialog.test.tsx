import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ChannelRequestError } from '@/kcoder/channels'
import { channelFixture, channelTarget } from '@/kcoder/channels.test-fixtures'
import { TaskBindingPicker } from './TaskChannelBindingDialog'

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
