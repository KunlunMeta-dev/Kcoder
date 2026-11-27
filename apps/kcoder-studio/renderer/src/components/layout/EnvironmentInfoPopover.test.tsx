import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'

describe('EnvironmentInfoPopover', () => {
  const portalContainers: HTMLElement[] = []

  afterEach(() => {
    vi.useRealTimers()
    portalContainers.splice(0).forEach(container => container.remove())
  })

  test('shows the device IP instead of an executor id for offline errors', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'cloud',
          deviceId: '9562a3b4-61a3-4217-9655-0341b231eb06',
          error: 'executor-offline:9562a3b4-61a3-4217-9655-0341b231eb06',
        }}
        devices={[
          {
            id: 1,
            device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
            name: 'build-executor-0341b231eb06',
            status: 'offline',
            is_default: false,
            device_type: 'remote',
            client_ip: '203.0.113.10',
          },
        ]}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const popover = screen.getByTestId('environment-info-popover')
    expect(popover).toHaveTextContent('203.0.113.10 已离线，恢复在线后可继续对话')
    expect(popover).not.toHaveTextContent('executor-offline:')
    expect(popover).not.toHaveTextContent('9562a3b4-61a3-4217-9655-0341b231eb06')
  })

  test('delegates open state to the app shell without writing browser storage', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    function ControlledPopover() {
      const [open, setOpen] = useState(true)
      return (
        <EnvironmentInfoPopover
          info={{
            additions: '',
            deletions: '',
            executionTarget: 'local',
          }}
          popoverContainer={popoverContainer}
          open={open}
          onOpenChange={setOpen}
        />
      )
    }

    const first = render(<ControlledPopover />)

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()

    first.unmount()
    render(<ControlledPopover />)
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()
  })

  test('shows TODO binding and delivery actions for a local task', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const onDeliver = vi.fn()
    const onManageTodo = vi.fn()

    render(
      <EnvironmentInfoPopover
        info={{ additions: '', deletions: '', executionTarget: 'local' }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onDeliver={onDeliver}
        onManageTodo={onManageTodo}
      />
    )

    expect(screen.getByTestId('environment-todo-binding-button')).toHaveTextContent('关联项目空间')
    expect(screen.getByTestId('environment-delivery-button')).toHaveTextContent('交付到任务…')
    await userEvent.click(screen.getByTestId('environment-todo-binding-button'))
    await userEvent.click(screen.getByTestId('environment-delivery-button'))
    expect(onManageTodo).toHaveBeenCalledOnce()
    expect(onDeliver).toHaveBeenCalledOnce()
  })

  test('shows every workspace root for a multi-folder project', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: '/workspace/web',
          workspaceRoots: ['/workspace/web', '/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('web')
    expect(screen.getByTestId('environment-workspace-root-1')).toHaveTextContent('api')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      '/workspace/api'
    )
    expect(screen.getByTestId('environment-workspace-path-button')).toHaveClass('min-h-11')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveClass('min-h-11')
  })

  test('shows a managed worktree as the primary task path before project roots', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: '/workspace/.managed/task-1',
          workspaceRoots: ['/workspace/source', '/workspace/source-api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path-button')).toHaveAttribute(
      'title',
      '/workspace/.managed/task-1'
    )
    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('task-1')
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      '/workspace/source'
    )
    expect(screen.getByTestId('environment-workspace-root-button-2')).toHaveAttribute(
      'title',
      '/workspace/source-api'
    )
  })

  test('moves the active workspace root first without rendering it twice', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspacePath: '/workspace/api',
          workspaceRoots: ['/workspace/web', '/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('environment-workspace-path-button')).toHaveAttribute(
      'title',
      '/workspace/api'
    )
    expect(screen.getByTestId('environment-workspace-root-button-1')).toHaveAttribute(
      'title',
      '/workspace/web'
    )
    expect(screen.queryByTestId('environment-workspace-root-button-2')).not.toBeInTheDocument()
  })

  test('keeps the newest workspace copy confirmation visible for its full duration', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'local',
          workspaceRoots: ['/workspace/web', '/workspace/api'],
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('environment-workspace-path-button'))
    })
    expect(
      screen.getByTestId('environment-workspace-path-button').querySelector('[role="status"]')
    ).not.toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('environment-workspace-root-button-1'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })

    expect(
      screen.getByTestId('environment-workspace-root-button-1').querySelector('[role="status"]')
    ).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(
      screen.getByTestId('environment-workspace-root-button-1').querySelector('[role="status"]')
    ).toBeNull()
  })

  test('shows additions and deletions and keeps the row stable while refreshing statistics', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const props = {
      popoverContainer,
      open: true,
      onOpenChange: vi.fn(),
      onOpenChangesReview: vi.fn(),
    }
    const info = {
      additions: '+3,438',
      deletions: '-220',
      executionTarget: 'local' as const,
      isGitRepository: true,
    }
    const { rerender } = render(<EnvironmentInfoPopover {...props} info={info} />)
    expect(screen.getByTestId('environment-changes-button')).toBeEnabled()
    expect(screen.getByTestId('environment-change-counts')).toHaveTextContent('+3,438')
    expect(screen.getByTestId('environment-change-counts')).toHaveTextContent('-220')

    rerender(<EnvironmentInfoPopover {...props} info={{ ...info, loading: true }} />)
    expect(screen.getByTestId('environment-changes-button')).toBeVisible()
    expect(screen.getByTestId('environment-change-counts')).toHaveTextContent('+3,438')
    expect(screen.getByTestId('environment-change-counts')).toHaveTextContent('-220')
  })

  test('keeps the changes row visible without inventing counts or Git actions for a non-git workspace', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          isGitRepository: false,
          workspacePath: '/workspace/plain-project',
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onOpenChangesReview={vi.fn()}
      />
    )

    expect(screen.queryByTestId('environment-git-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-changes-button')).toBeVisible()
    expect(screen.getByTestId('environment-changes-button')).toBeDisabled()
    expect(screen.getByTestId('environment-change-counts')).toHaveTextContent('—')
    expect(screen.queryByText('+0')).not.toBeInTheDocument()
    expect(screen.queryByText('-0')).not.toBeInTheDocument()
  })

  test.each([
    ['merge-base', 'origin/main', '相对 origin/main 的共同祖先'],
    ['head', 'HEAD', '相对 HEAD（最近一次提交）'],
    ['empty', null, '相对空仓库（尚无提交）'],
  ] as const)(
    'explains the %s comparison and shared line-count scope on hover or focus',
    (kind, reference, label) => {
      const popoverContainer = document.createElement('div')
      document.body.appendChild(popoverContainer)
      portalContainers.push(popoverContainer)
      render(
        <EnvironmentInfoPopover
          info={{
            additions: '+15',
            deletions: '-2',
            executionTarget: 'local',
            branchName: 'feature/counts',
            workspacePath: '/workspace/feature',
            changeSummary: {
              kind,
              reference,
              commit: kind === 'empty' ? null : 'a'.repeat(40),
              fileCount: 4,
              binaryFiles: 1,
            },
          }}
          popoverContainer={popoverContainer}
          open
          onOpenChange={vi.fn()}
          onOpenChangesReview={vi.fn()}
        />
      )
      expect(screen.getByTestId('environment-comparison-base')).toHaveTextContent('feature/counts')
      expect(screen.getByTestId('environment-comparison-base')).toHaveTextContent(label)
      const button = screen.getByTestId('environment-changes-button')
      const description = screen.getByTestId('environment-changes-description')
      expect(button).toHaveAttribute('aria-describedby', description.id)
      expect(description).not.toBeVisible()
      fireEvent.mouseEnter(button.parentElement!)
      expect(description).toBeVisible()
      expect(description.parentElement).toBe(document.body)
      expect(description).toHaveTextContent('工作区：/workspace/feature')
      expect(description).toHaveTextContent('分支已提交变更、暂存及未暂存修改、未跟踪文件')
      expect(description).toHaveTextContent('1 个二进制文件不计入增删行数')
      expect(description).toHaveTextContent('不限于本次对话')
    }
  )

  test('labels a legacy comparison as unknown instead of guessing main or HEAD', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+5',
          deletions: '-2',
          executionTarget: 'local',
          branchName: 'feature/legacy',
          untrackedFileCount: 2,
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('environment-comparison-base')).toHaveTextContent(
      '后端尚未提供比较基准'
    )
    expect(screen.getByText('旧版后端：统计范围尚未确认。')).toBeVisible()
    expect(screen.getByTestId('environment-changes-description')).toHaveTextContent(
      '检测到 2 项未跟踪内容'
    )
  })

  test('submits from the portaled commit form without closing the floating popover first', async () => {
    const onCommitChanges = vi.fn().mockResolvedValue(undefined)

    function FloatingPopover() {
      const [open, setOpen] = useState(true)
      return (
        <EnvironmentInfoPopover
          info={{
            additions: '+1',
            deletions: '-0',
            executionTarget: 'local',
            branchName: 'feature/floating-commit',
            workspacePath: '/workspace/project',
          }}
          popoverContainer={null}
          docked={false}
          open={open}
          onOpenChange={setOpen}
          onCommitChanges={onCommitChanges}
        />
      )
    }

    render(<FloatingPopover />)
    await userEvent.click(screen.getByTestId('environment-commit-button'))
    await userEvent.type(
      screen.getByTestId('environment-commit-message-input'),
      'test: floating commit'
    )
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    expect(onCommitChanges).toHaveBeenCalledWith('test: floating commit')
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
  })

  test('branch ownership follows the resolved target before an old environment snapshot has been replaced', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const props = { info: { additions: '', deletions: '', executionTarget: 'local' as const,
      deviceId: 'popover-branch-owner', workspacePath: '/original', branchName: 'main' },
      popoverContainer, open: true, onOpenChange: vi.fn(),
      onListBranches: vi.fn().mockResolvedValue(['main', 'owned-feature']), onCheckoutBranch: vi.fn() }
    const view = render(<EnvironmentInfoPopover {...props} target={{ deviceId: 'popover-branch-owner', path: '/original' }} />)
    await userEvent.click(screen.getByTestId('environment-branch-row'))
    expect(screen.getByTestId('environment-branch-menu')).toBeVisible()
    view.rerender(<EnvironmentInfoPopover {...props} target={{ deviceId: 'popover-branch-owner', path: '/replacement' }} />)
    expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
    expect(props.onListBranches).toHaveBeenCalledTimes(1)
    expect(props.onCheckoutBranch).not.toHaveBeenCalled()
  })

})
