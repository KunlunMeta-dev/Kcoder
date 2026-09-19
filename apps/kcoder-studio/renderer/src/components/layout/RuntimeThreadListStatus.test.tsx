import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import i18n from '@/i18n'
import { RuntimeThreadListStatus } from './RuntimeThreadListStatus'

test('shows a localized partial count beside the workspace and clears it on recovery', async () => {
  await i18n.changeLanguage('en')
  const workspace = {
    deviceId: 'local',
    workspacePath: '/project',
    label: 'Project',
    available: true,
    tasks: [],
    threadsComplete: false,
    threadListIssueCount: 3,
  }
  const view = render(<RuntimeThreadListStatus workspaces={[workspace]} />)
  expect(screen.getByRole('status')).toHaveTextContent('Project')
  expect(screen.getByRole('status')).toHaveTextContent('3')
  expect(screen.getByRole('status')).toHaveTextContent('incomplete')
  view.rerender(
    <RuntimeThreadListStatus
      workspaces={[{ ...workspace, threadsComplete: true, threadListIssueCount: 0 }]}
    />
  )
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('shows the dedicated sync failure message instead of the issue count', async () => {
  await i18n.changeLanguage('zh-CN')
  const workspace = {
    deviceId: 'srv-1',
    workspacePath: '/repo',
    label: 'Repo',
    available: true,
    tasks: [],
    threadsComplete: false,
    threadListIssueCount: 1,
    threadListSyncFailed: true,
  }
  const view = render(<RuntimeThreadListStatus workspaces={[workspace]} />)
  expect(screen.getByTestId('runtime-thread-list-incomplete')).toHaveTextContent('无法同步')
  expect(screen.getByTestId('runtime-thread-list-incomplete')).not.toHaveTextContent('个问题')
  view.rerender(
    <RuntimeThreadListStatus workspaces={[{ ...workspace, threadListSyncFailed: false }]} />
  )
  expect(screen.getByTestId('runtime-thread-list-incomplete')).toHaveTextContent('1 个问题')
  expect(screen.getByTestId('runtime-thread-list-incomplete')).not.toHaveTextContent('无法同步')
})
