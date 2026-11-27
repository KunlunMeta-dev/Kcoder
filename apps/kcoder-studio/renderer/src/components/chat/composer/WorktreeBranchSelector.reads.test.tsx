import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { WorktreeBranchSelector } from './WorktreeBranchSelector'

const target = { deviceId: 'worktree-menu-owner', path: '/owned/worktree' }

test('same-workspace callback enrichment does not repeatedly read the branch directory', async () => {
  const read = vi.fn().mockResolvedValue(['main', 'feature/owned']),
    select = vi.fn()
  const view = render(
    <WorktreeBranchSelector
      target={target}
      currentBranch="main"
      onListBranches={() => read()}
      onSelectBranch={select}
    />
  )
  await userEvent.click(screen.getByTestId('project-worktree-branch-button'))
  expect(screen.getByText('feature/owned')).toBeVisible()
  for (let index = 0; index < 12; index++)
    await act(async () => {
      view.rerender(
        <WorktreeBranchSelector
          target={{ ...target }}
          currentBranch="main"
          onListBranches={() => read()}
          onSelectBranch={select}
        />
      )
    })
  expect(read).toHaveBeenCalledTimes(1)
  expect(select).not.toHaveBeenCalled()
})

test.each(['workspace', 'account'] as const)(
  'a worktree hint menu cannot retain old choices after %s changes',
  async change => {
    const props = {
      target,
      currentBranch: 'main',
      onListBranches: vi.fn().mockResolvedValue(['main', 'feature/owned']),
      onSelectBranch: vi.fn(),
    }
    const view = render(<WorktreeBranchSelector {...props} />)
    await userEvent.click(screen.getByTestId('project-worktree-branch-button'))
    await act(async () => {
      if (change === 'workspace')
        view.rerender(
          <WorktreeBranchSelector {...props} target={{ ...target, path: '/replacement' }} />
        )
      else notifyAccountContextChange(target.deviceId)
    })
    expect(screen.queryByTestId('project-worktree-branch-menu')).not.toBeInTheDocument()
    expect(props.onListBranches).toHaveBeenCalledTimes(1)
    expect(props.onSelectBranch).not.toHaveBeenCalled()
  }
)
