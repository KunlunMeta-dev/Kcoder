import '@/i18n'
import { screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { channelFixture } from '@/kcoder/channels.test-fixtures'
import { invalidateChannelBindings } from '@/kcoder/channelBindingEvents'
import { enableGateway, renderSidebar } from './sidebar/DesktopSidebar.test-support'

const owned = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/kcoder/channels', () => ({ channelInventory: owned.read }))

afterEach(() => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
  vi.clearAllMocks()
})

test('bound task shows its platform before the title and unbind removes only that icon', async () => {
  localStorage.clear()
  enableGateway()
  const inventory = channelFixture()
  inventory.connections[0].label = 'Original Feishu'
  const target = { serverId: 'local-device', workspacePath: '/owned/workspace', threadId: 'original-task' }
  inventory.chats[0].bindingRevision = 1
  inventory.chats[0].binding = { chatId: 'observed-chat', target, revision: 1 }
  let summary = inventory.chats
  owned.read.mockImplementation(async () => ({ ...inventory, chats: summary }))
  const view = renderSidebar({
    onOpenRuntimeTask: vi.fn(),
    runtimeWork: {
      projects: [],
      totalTasks: 2,
      chats: [
        {
          id: 91,
          deviceId: 'local-device',
          deviceName: 'Local',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/owned/workspace',
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'bound-task',
              threadId: target.threadId,
              workspacePath: '/owned/workspace',
              title: '你是谁',
              runtime: 'kcoder',
            },
            {
              taskId: 'plain-task',
              threadId: 'plain-task',
              workspacePath: '/owned/workspace',
              title: '普通任务',
              runtime: 'kcoder',
            },
          ],
        },
      ],
    },
  })
  const icon = await screen.findByTestId('runtime-local-task-channel-bound-task')
  expect(icon).toHaveAttribute('data-platform', 'feishu')
  expect(icon).toHaveAttribute('data-connection-id', 'connection')
  expect(icon).toHaveAccessibleName(expect.stringContaining('Original Feishu'))
  expect(icon.querySelector('img')).toHaveAttribute('src', expect.stringContaining('feishu.svg'))
  const row = screen.getByTestId('runtime-local-task-row-bound-task')
  expect(row.children).toHaveLength(2)
  expect(row.children[0].firstChild).toBe(icon)
  expect(row.children[0]).toHaveTextContent('你是谁')
  expect(row.children[1]).toHaveAttribute('data-testid', 'runtime-local-task-trailing-bound-task')
  expect(screen.queryByTestId('runtime-local-task-channel-plain-task')).not.toBeInTheDocument()
  summary = []
  invalidateChannelBindings('gateway-channels')
  await waitFor(() =>
    expect(screen.queryByTestId('runtime-local-task-channel-bound-task')).not.toBeInTheDocument()
  )
  expect(row).toHaveTextContent('你是谁')
  expect(owned.read).toHaveBeenCalledTimes(2)
  view.unmount()
})
