import '@/i18n'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { renderSidebar } from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
test('renders partial thread list status in the project sidebar', () => {
  renderSidebar({
    runtimeWork: {
      projects: [
        {
          project: { id: 7, key: 'project-7', name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              workspacePath: '/workspace',
              label: 'Wegent',
              available: true,
              workspaceSource: 'local',
              threadsComplete: false,
              threadListIssueCount: 3,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    },
  })
  expect(screen.getByTestId('runtime-thread-list-incomplete')).toHaveTextContent('3')
})

test('opens the actual project history refresh confirmation from its project menu', async () => {
  renderSidebar({
    runtimeWork: {
      projects: [
        {
          project: { id: 7, key: 'project-7', name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              workspacePath: '/workspace',
              available: true,
              workspaceSource: 'local',
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    },
  })
  await userEvent.click(screen.getByTestId('project-menu-7'))
  await userEvent.click(screen.getByTestId('refresh-project-history-7'))
  expect(screen.getByTestId('project-history-refresh-dialog')).toBeInTheDocument()
  expect(screen.getByTestId('history-refresh-target')).toHaveValue(
    JSON.stringify(['local-device', '/workspace'])
  )
  expect(screen.getByTestId('project-history-refresh-dialog-confirm')).toBeDisabled()
})
