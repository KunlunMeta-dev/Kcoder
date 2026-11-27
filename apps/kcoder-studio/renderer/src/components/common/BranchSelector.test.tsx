import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { BranchSelector } from './BranchSelector'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

const target = { deviceId: 'branch-menu-owner', path: '/owned/branches' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('a pending checkout disables branch creation until its original result settles', async () => {
  const pending = deferred<void>()
  const onCreateBranch = vi.fn().mockResolvedValue(undefined)
  render(<BranchSelector variant="workbar" target={target} currentBranch="main"
    onListBranches={vi.fn().mockResolvedValue(['main', 'owned-feature'])}
    onSelectBranch={() => pending.promise} onCreateBranch={onCreateBranch} />)
  try {
    await userEvent.click(screen.getByTestId('project-branch-button'))
    await userEvent.click(screen.getByTestId('project-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('project-new-branch-input'), 'owned-new-branch')
    await userEvent.click(screen.getByText('owned-feature'))
    expect(screen.getByTestId('project-confirm-new-branch-button')).toBeDisabled()
    expect(onCreateBranch).not.toHaveBeenCalled()
  } finally { await act(async () => { pending.resolve() }) }
})

test.each(['success', 'failure'] as const)(
  'a closed branch read cannot replace a reopened menu after late %s',
  async result => {
    const old = deferred<string[]>(),
      current = deferred<string[]>()
    const onListBranches = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise)
    render(
      <BranchSelector
        variant="workbar"
        currentBranch="main"
        onListBranches={onListBranches}
        onSelectBranch={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('project-branch-button'))
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByTestId('project-branch-button'))
    expect(onListBranches).toHaveBeenCalledTimes(2)
    await act(async () => {
      if (result === 'success') old.resolve(['obsolete-branch'])
      else old.reject(new Error('obsolete failure'))
    })
    const menu = screen.getByTestId('project-branch-menu')
    expect(within(menu).queryByText('obsolete-branch')).not.toBeInTheDocument()
    expect(within(menu).queryByText('obsolete failure')).not.toBeInTheDocument()
    expect(within(menu).getByText(/加载中/)).toBeVisible()
    await act(async () => {
      current.resolve(['current-branch'])
    })
    expect(within(menu).getByText('current-branch')).toBeVisible()
  }
)

test.each(['close', 'unmount'] as const)(
  '%s while refresh is pending does not start a later branch query',
  async action => {
    const refresh = deferred<void>(),
      onListBranches = vi.fn().mockResolvedValue(['main'])
    const view = render(
      <BranchSelector
        variant="workbar"
        onRefresh={() => refresh.promise}
        onListBranches={onListBranches}
        onSelectBranch={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('project-branch-button'))
    if (action === 'close') await userEvent.keyboard('{Escape}')
    else view.unmount()
    await act(async () => {
      refresh.resolve()
    })
    expect(onListBranches).not.toHaveBeenCalled()
  }
)

test('an invalidated branch read closes without exposing internal cancellation details', async () => {
  const onListBranches = vi
    .fn()
    .mockRejectedValue(new DOMException('Environment observation changed', 'AbortError'))
  render(
    <BranchSelector variant="workbar" onListBranches={onListBranches} onSelectBranch={vi.fn()} />
  )
  await userEvent.click(screen.getByTestId('project-branch-button'))
  expect(onListBranches).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('project-branch-menu')).not.toBeInTheDocument()
  expect(screen.queryByText('Environment observation changed')).not.toBeInTheDocument()
})

test.each(['workspace', 'account', 'configuration'] as const)(
  'an open branch menu retires on %s without querying or mutating the replacement source',
  async change => {
    const props = {
      variant: 'workbar' as const,
      currentBranch: 'main',
      target,
      onListBranches: vi.fn().mockResolvedValue(['main', 'owned-feature']),
      onSelectBranch: vi.fn(),
    }
    const view = render(<BranchSelector {...props} />)
    await userEvent.click(screen.getByTestId('project-branch-button'))
    expect(screen.getByText('owned-feature')).toBeVisible()
    await act(async () => {
      if (change === 'workspace')
        view.rerender(<BranchSelector {...props} target={{ ...target, path: '/replacement' }} />)
      if (change === 'account') notifyAccountContextChange(target.deviceId)
      if (change === 'configuration')
        window.dispatchEvent(
          new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.deviceId } })
        )
    })
    expect(screen.queryByTestId('project-branch-menu')).not.toBeInTheDocument()
    expect(props.onListBranches).toHaveBeenCalledTimes(1)
    expect(props.onSelectBranch).not.toHaveBeenCalled()
  }
)

test('unrelated invalidations and same-workspace metadata keep the original menu without reading', async () => {
  const props = {
    variant: 'workbar' as const,
    currentBranch: 'main',
    target,
    onListBranches: vi.fn().mockResolvedValue(['main']),
    onSelectBranch: vi.fn(),
  }
  const view = render(<BranchSelector {...props} />)
  await userEvent.click(screen.getByTestId('project-branch-button'))
  const menu = screen.getByTestId('project-branch-menu')
  await userEvent.type(screen.getByTestId('project-branch-search-input'), 'mai')
  await act(async () => {
    notifyAccountContextChange('unrelated-branch-target')
    window.dispatchEvent(
      new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'unrelated-branch-target' } })
    )
    view.rerender(<BranchSelector {...props} target={{ ...target }} currentBranch="updated-main" />)
  })
  expect(screen.getByTestId('project-branch-menu')).toBe(menu)
  expect(screen.getByTestId('project-branch-search-input')).toHaveValue('mai')
  expect(props.onListBranches).toHaveBeenCalledTimes(1)
})

test.each(['success', 'failure'] as const)(
  'a late checkout %s cannot close or rewrite a new workspace menu',
  async outcome => {
    const mutation = deferred<void>()
    const props = {
      variant: 'workbar' as const,
      currentBranch: 'main',
      target,
      onListBranches: vi.fn().mockResolvedValue(['main', 'owned-feature']),
      onSelectBranch: vi.fn().mockReturnValue(mutation.promise),
    }
    const view = render(<BranchSelector {...props} />)
    await userEvent.click(screen.getByTestId('project-branch-button'))
    await userEvent.click(screen.getByText('owned-feature'))
    expect(props.onSelectBranch).toHaveBeenCalledTimes(1)
    view.rerender(<BranchSelector {...props} target={{ ...target, path: '/replacement' }} />)
    await userEvent.click(screen.getByTestId('project-branch-button'))
    const menu = screen.getByTestId('project-branch-menu')
    await act(async () => {
      if (outcome === 'success') mutation.resolve()
      else mutation.reject(new Error('old workspace mutation failed'))
    })
    expect(screen.getByTestId('project-branch-menu')).toBe(menu)
    expect(screen.queryByText('old workspace mutation failed')).not.toBeInTheDocument()
    expect(within(menu).getByText('owned-feature')).toBeEnabled()
    expect(props.onSelectBranch).toHaveBeenCalledTimes(1)
  }
)
