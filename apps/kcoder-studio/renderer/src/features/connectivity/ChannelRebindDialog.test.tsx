import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { ChannelRequestError } from '@/kcoder/channels'
import { channelFixture } from '@/kcoder/channels.test-fixtures'
import { ChannelRebindDialog } from './ChannelRebindDialog'

const api = vi.hoisted(() => ({ read: vi.fn(), act: vi.fn(), isCurrent: () => true }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'owned-target', isCurrent: api.isCurrent }) }))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelInventory: api.read, channelAction: api.act }))
let page = channelFixture()
beforeEach(() => {
  page = channelFixture()
  page.chats[0].bindingRevision = 7
  page.chats[0].binding = { chatId: page.chats[0].id, revision: 7,
    target: { serverId: 'old-target', workspacePath: '/old/workspace', threadId: 'old-thread' } }
  api.read.mockImplementation(async () => structuredClone(page))
  api.act.mockImplementation(async body => {
    page.chats[0].bindingRevision++
    page.chats[0].binding = { chatId: body.chatId, target: body.target, revision: page.chats[0].bindingRevision }
    return page.chats[0].binding
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
const key = JSON.stringify(['new-target', '/new/workspace', 'real-new-thread'])
function show() {
  const closed = vi.fn(), changed = vi.fn()
  const workbench = { state: { runtimeWork: { projects: [], chats: [{ deviceId: 'new-target', deviceName: 'New server',
    available: true, workspacePath: '/new/workspace', tasks: [
      { taskId: 'kcoder:new-target:real-new-thread', runtime: 'kcoder', title: 'Replacement task', workspacePath: '/new/workspace',
        runtimeHandle: { threadId: 'real-new-thread' } },
      { taskId: 'optimistic-id', runtime: 'kcoder', title: 'Unsaved draft', workspacePath: '/new/workspace', optimistic: true,
        threadId: 'draft' },
    ] }] } } } as unknown as WorkbenchContextValue
  render(<WorkbenchContext.Provider value={workbench}><ChannelRebindDialog chat={page.chats[0]} onClose={closed} onChanged={changed} /></WorkbenchContext.Provider>)
  return { closed, changed }
}
async function review() {
  fireEvent.change(screen.getByRole('combobox', { name: 'channelPresentation.replacementTask' }), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: 'channelPresentation.reviewRebind' }))
  await screen.findByText('chatTasks.noCurrentBinding')
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.bindTask' }))
}

test('rebind selects a saved original thread and replaces only this chat after confirmation', async () => {
  const { closed, changed } = show()
  expect(screen.getByRole('button', { name: 'channelPresentation.reviewRebind' })).toBeDisabled()
  expect(screen.queryByRole('option', { name: /Unsaved draft/ })).not.toBeInTheDocument()
  await review()
  expect(api.act).not.toHaveBeenCalled()
  expect(screen.getByText('chatTasks.switchConfirm')).toBeInTheDocument()
  expect(screen.getByText(/Replacement task/)).toBeInTheDocument()
  const picker = screen.getByTestId('task-binding-picker')
  expect(within(picker).getByRole('radio')).toBeChecked()
  expect(within(picker).queryByRole('combobox')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.confirm' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(api.act).toHaveBeenCalledExactlyOnceWith({ action: 'bind', chatId: 'observed-chat', expectedBindingRevision: 7,
    target: { serverId: 'new-target', workspacePath: '/new/workspace', threadId: 'real-new-thread' } }, expect.any(AbortSignal))
  expect(closed).toHaveBeenCalledOnce()
})

test('an unknown rebind outcome remains visible and refresh does not repeat the mutation', async () => {
  api.act.mockRejectedValue(new ChannelRequestError('CHANNEL_REQUEST_UNKNOWN', true))
  const { closed, changed } = show()
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.confirm' }))
  await screen.findByText('chatTasks.unconfirmed')
  fireEvent.click(screen.getByRole('button', { name: 'octop.refresh' }))
  await waitFor(() => expect(api.read.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(api.act).toHaveBeenCalledOnce()
  expect(closed).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

test('a concurrent binding change is reported instead of silently replacing the newer route', async () => {
  api.act.mockRejectedValue(new ChannelRequestError('CHANNEL_BINDING_CHANGED'))
  const { changed } = show()
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.confirm' }))
  await screen.findByText('CHANNEL_BINDING_CHANGED')
  expect(api.act).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
  expect(page.chats[0].binding?.target.threadId).toBe('old-thread')
})
