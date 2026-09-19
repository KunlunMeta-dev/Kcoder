import './DesktopWorkbenchLayout.test-mocks'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import {
  DesktopWorkbenchLayout,
  activeProjectRuntimeTarget,
  activeProjectRuntimeTask,
  activeProjectState,
  baseProps,
} from './DesktopWorkbenchLayout.test-harness'
import {
  createLocalRuntimeTaskPanelFixture,
  mockDesktopWorkbenchMainWidth,
} from './DesktopWorkbenchMain.workspace.test-support'

describe('DesktopWorkbenchLayout', () => {
  test('starts the summary collapsed and keeps it open after an explicit click', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: activeProjectState.currentProject,
          devices: [
            {
              id: 1,
              device_id: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
              name: 'dev-executor-0bb4',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              client_ip: '203.0.113.67',
            },
          ],
        }}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+173',
          deletions: '-13366',
          executionTarget: 'cloud',
          deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
          workspacePath: '/workspace/projects/github_wegent',
          branchName: 'human/narwhal-20260528-073440',
          createPullRequestUrl:
            'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
        })}
      />
    )

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-info-button')).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    const environmentInfoPanel = screen.getByTestId('environment-info-panel-container')
    const environmentInfoPopover = screen.getByTestId('environment-info-popover')
    expect(environmentInfoPanel).toContainElement(environmentInfoPopover)
    expect(environmentInfoPopover).toHaveAttribute('data-environment-info-popover')
    expect(environmentInfoPanel.matches(':has([data-environment-info-popover])')).toBe(true)
    expect(screen.getByTestId('desktop-workbench-content')).toContainElement(environmentInfoPanel)
    expect(environmentInfoPanel).toHaveClass(
      'overflow-hidden',
      'has-[[data-environment-info-popover]]:overflow-visible'
    )
    expect(screen.getByTestId('environment-info-popover')).toHaveClass(
      'w-[300px]',
      'bg-background',
      'text-text-primary',
      'border-border',
      'backdrop-blur-3xl',
      'backdrop-saturate-150'
    )
    expect(screen.getByTestId('environment-info-popover')).not.toHaveClass(
      'shadow-[0_18px_44px_rgba(0,0,0,0.24)]'
    )
    expect(screen.getByText('环境')).toBeInTheDocument()
    expect(screen.getByText('变更')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('+173')).toBeInTheDocument())
    const deviceSection = screen.getByTestId('environment-device-section')
    const gitSection = screen.getByTestId('environment-git-section')
    expect(deviceSection).toHaveClass('flex', 'flex-col', 'gap-1')
    expect(deviceSection).not.toContainElement(gitSection)
    expect(gitSection).not.toContainElement(deviceSection)
    const executionTargetRow = screen.getByTestId('environment-execution-target-row')
    expect(deviceSection).toContainElement(executionTargetRow)
    expect(executionTargetRow).toHaveTextContent('位置')
    expect(executionTargetRow).toHaveTextContent('云设备')
    const deviceButton = await screen.findByTestId('environment-device-button')
    expect(deviceSection).toContainElement(deviceButton)
    expect(deviceButton).toHaveTextContent('设备')
    expect(deviceButton).toHaveTextContent('203.0.113.67')
    expect(deviceButton).not.toHaveTextContent('云设备')
    expect(deviceButton).not.toHaveTextContent('e13e1a10')
    expect(deviceButton).not.toHaveTextContent('8ef4')
    expect(screen.queryByTestId('environment-device-id')).not.toBeInTheDocument()
    expect(executionTargetRow).toHaveAttribute(
      'title',
      '位置 · 云设备; 设备 · dev-executor-0bb4'
    )
    const workspacePathButton = screen.getByTestId('environment-workspace-path-button')
    expect(deviceSection).toContainElement(workspacePathButton)
    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('github_wegent')
    expect(workspacePathButton).toHaveAccessibleName('路径 · /workspace/projects/github_wegent')
    expect(workspacePathButton).toContainElement(
      screen.getByTestId('environment-workspace-path-copy-icon')
    )
    expect(gitSection).toHaveTextContent('变更')
    expect(await screen.findByText('+173')).toBeInTheDocument()
    expect(await screen.findByText('-13366')).toBeInTheDocument()
    expect(gitSection).toHaveTextContent('human/narwhal-20260528-073440')
    expect(gitSection).toHaveTextContent('提交')
    expect(gitSection).toHaveTextContent('创建拉取请求')
    expect(gitSection).not.toHaveTextContent('来源')

    await userEvent.click(deviceButton)

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

    await userEvent.click(workspacePathButton)

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      '/workspace/projects/github_wegent'
    )
    expect(screen.getByText('已复制')).toHaveAttribute('role', 'status')

    await userEvent.click(document.body)

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(environmentInfoPanel.matches(':has([data-environment-info-popover])')).toBe(false)
    expect(environmentInfoPanel).toHaveClass('overflow-hidden')
  })

  test.each([1024, 720])('isolates summary choices per task at width %s', async width => {
    mockDesktopWorkbenchMainWidth(width)
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const renderTask = (task: typeof taskA) => <DesktopWorkbenchLayout {...propsForTask(task)} />
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const view = render(renderTask(taskA))

    expect(activePane().getByTestId('environment-info-button')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await userEvent.click(activePane().getByTestId('environment-info-button'))
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()

    view.rerender(renderTask(taskB))

    expect(activePane().getByTestId('environment-info-panel-container')).toHaveClass(
      'transition-none'
    )
    await waitFor(() =>
      expect(activePane().getByTestId('environment-info-button')).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    )
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    await userEvent.click(activePane().getByTestId('environment-info-button'))
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    await userEvent.click(activePane().getByTestId('environment-info-button'))

    view.rerender(renderTask(taskA))
    await waitFor(() =>
      expect(activePane().getByTestId('environment-info-button')).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    )
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    view.rerender(renderTask(taskB))
    expect(activePane().getByTestId('environment-info-button')).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    view.unmount()
    render(renderTask(taskA))

    expect(activePane().getByTestId('environment-info-button')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(activePane().queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('keeps the overlay summary state separate from the pinned summary state', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...activeProjectState, currentRuntimeTask: activeProjectRuntimeTask }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.getByTestId('environment-info-popover')).not.toHaveClass('fixed')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    await waitFor(() =>
      expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.getByTestId('environment-info-popover')).toHaveClass('fixed')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    await waitFor(() =>
      expect(screen.getByTestId('environment-info-popover')).not.toHaveClass('fixed')
    )
    expect(screen.getByTestId('environment-info-button')).toHaveAttribute('aria-expanded', 'true')
  })

  test('opens environment changes review in the right workspace panel', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-changes-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentDiff).toHaveBeenCalledWith(null, activeProjectRuntimeTarget, 'branch')
    )
    expect(screen.queryByRole('dialog', { name: '本轮文件变更' })).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('new')
  })

  test('submits environment commits from the popover', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))
    await userEvent.type(screen.getByTestId('environment-commit-message-input'), 'feat: ship')
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(
        null,
        'feat: ship',
        activeProjectRuntimeTarget
      )
    )
    expect(screen.getByText('已提交')).toBeInTheDocument()
  })

  test('submits an empty environment commit message so AI can generate it', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))

    const confirmButton = screen.getByTestId('environment-confirm-commit-button')
    expect(confirmButton).toBeEnabled()
    await userEvent.click(confirmButton)

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(null, '', activeProjectRuntimeTarget)
    )
  })

  test('renders the environment commit menu as the compact commit or push panel', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitAndPushEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    const onPushEnvironmentChanges = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitAndPushEnvironmentChanges={onCommitAndPushEnvironmentChanges}
        onPushEnvironmentChanges={onPushEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    const popover = await screen.findByTestId('environment-info-popover')
    const commitMenuButton = await screen.findByTestId('environment-commit-button')
    expect(commitMenuButton).toHaveTextContent('提交或推送')

    await userEvent.click(commitMenuButton)

    const commitPanel = screen.getByTestId('environment-commit-form')
    expect(commitPanel).toHaveClass('fixed', 'left-1/2', 'w-[430px]', 'rounded-xl')
    expect(popover).not.toContainElement(commitPanel)
    expect(commitPanel).toHaveTextContent('包含未暂存的更改')

    const scopedPanel = within(commitPanel)
    expect(scopedPanel.getByTestId('environment-confirm-commit-button')).toHaveTextContent('提交')
    expect(scopedPanel.getByTestId('environment-commit-and-push-button')).toHaveTextContent(
      '提交并推送'
    )
    expect(scopedPanel.getByTestId('environment-push-button')).toHaveTextContent('推送')

    await userEvent.click(scopedPanel.getByTestId('environment-commit-and-push-button'))
    await waitFor(() =>
      expect(onCommitAndPushEnvironmentChanges).toHaveBeenCalledWith(
        null,
        '',
        activeProjectRuntimeTarget
      )
    )

    await userEvent.click(screen.getByTestId('environment-commit-button'))
    await userEvent.click(screen.getByTestId('environment-push-button'))
    await waitFor(() =>
      expect(onPushEnvironmentChanges).toHaveBeenCalledWith(null, activeProjectRuntimeTarget)
    )
  })

  test('shows the environment commit progress row while generating a message', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitEnvironmentChanges = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep the action pending so the in-popover progress row remains visible.
        })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    await waitFor(() => expect(onCommitEnvironmentChanges).toHaveBeenCalled())
    expect(screen.getByTestId('environment-commit-form')).toBeInTheDocument()
    expect(screen.getByTestId('environment-confirm-commit-button')).toHaveTextContent('提交中')
    expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-commit-progress-row')).toHaveTextContent(
      '正在生成消息...'
    )
    expect(screen.getByTestId('environment-commit-progress-stop-icon')).toBeInTheDocument()
  })

  test('keeps the commit form open and shows command failures', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onCommitEnvironmentChanges = vi
      .fn()
      .mockRejectedValue(new Error('git mutations are unavailable while an agent turn is running'))

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: { targetType: 'local', deviceId: 'device-1' },
              workspace: { source: 'local_path', localPath: '/workspace/github_wegent' },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))
    await userEvent.type(
      screen.getByTestId('environment-commit-message-input'),
      'test: preserve commit failure'
    )
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    expect(await screen.findByTestId('environment-commit-error')).toHaveTextContent(
      'git mutations are unavailable while an agent turn is running'
    )
    expect(screen.getByTestId('environment-commit-form')).toBeInTheDocument()
    expect(screen.getByTestId('environment-commit-message-input')).toHaveValue(
      'test: preserve commit failure'
    )
    const cancelButton = screen.getByTestId('environment-cancel-commit-button')
    expect(cancelButton).toBeVisible()
    await userEvent.click(cancelButton)
    expect(screen.queryByTestId('environment-commit-form')).not.toBeInTheDocument()
  })

  test('shows the environment push progress row while pushing', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onPushEnvironmentChanges = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep the action pending so the in-popover progress row remains visible.
        })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onPushEnvironmentChanges={onPushEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-commit-button'))
    await userEvent.click(screen.getByTestId('environment-push-button'))

    await waitFor(() => expect(onPushEnvironmentChanges).toHaveBeenCalled())
    expect(screen.queryByTestId('environment-commit-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('environment-commit-progress-row')).toHaveTextContent('正在推送...')
    expect(screen.getByTestId('environment-commit-progress-stop-icon')).toBeInTheDocument()
  })

  test('switches and creates branches from the environment popover', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    const onListEnvironmentBranches = vi
      .fn()
      .mockResolvedValue(['main', 'human/chipmunk-20260603-053420', 'human/alpaca-20260603-050330'])
    const onCheckoutEnvironmentBranch = vi.fn().mockResolvedValue(undefined)
    const onCreateEnvironmentBranch = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onListEnvironmentBranches={onListEnvironmentBranches}
        onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
        onCreateEnvironmentBranch={onCreateEnvironmentBranch}
        state={{
          ...baseProps.state,
          currentRuntimeTask: activeProjectRuntimeTask,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(await screen.findByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()
    await waitFor(() => expect(onListEnvironmentBranches).toHaveBeenCalledTimes(1))
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('human/chipmunk-20260603-053420')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('environment-branch-search-input'), 'alp')
    expect(screen.getByText('human/alpaca-20260603-050330')).toBeInTheDocument()
    expect(screen.queryByText('human/chipmunk-20260603-053420')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('human/alpaca-20260603-050330'))
    await waitFor(() =>
      expect(onCheckoutEnvironmentBranch).toHaveBeenCalledWith(
        null,
        'human/alpaca-20260603-050330',
        activeProjectRuntimeTarget
      )
    )

    await userEvent.click(await screen.findByTestId('environment-branch-row'))
    await userEvent.click(await screen.findByTestId('environment-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('environment-new-branch-input'), 'human/new-branch')
    await userEvent.click(screen.getByTestId('environment-confirm-new-branch-button'))

    await waitFor(() =>
      expect(onCreateEnvironmentBranch).toHaveBeenCalledWith(
        null,
        'human/new-branch',
        activeProjectRuntimeTarget
      )
    )
  })

  test('does not reopen the branch menu when the environment popover is reopened', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...activeProjectState, currentRuntimeTask: activeProjectRuntimeTask }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(await screen.findByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
  })

  test('keeps environment diff stats and branch row visible without a current branch', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...activeProjectState,
          currentRuntimeTask: activeProjectRuntimeTask,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'Local Executor',
              status: 'online',
              is_default: true,
              device_type: 'local',
            },
          ],
        }}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+55',
          deletions: '-8',
          executionTarget: 'local',
          deviceId: 'device-1',
          workspacePath: '/workspace/plain-folder',
          branchName: '',
        })}
        onListEnvironmentBranches={vi.fn().mockResolvedValue([])}
        onCheckoutEnvironmentBranch={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await waitFor(() => expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument())
    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent('plain-folder')
    expect(screen.getByTestId('environment-workspace-path-button')).toHaveAccessibleName(
      '路径 · /workspace/plain-folder'
    )
    expect(screen.getByTestId('environment-device-button')).toHaveTextContent('Local Executor')
    const gitSection = screen.getByTestId('environment-git-section')
    expect(gitSection).toHaveTextContent('变更')
    expect(gitSection).toHaveTextContent('+55')
    expect(gitSection).toHaveTextContent('-8')
    expect(screen.getByTestId('environment-branch-row')).toHaveTextContent('暂无分支')
    expect(screen.queryByTestId('environment-commit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-pull-request-button')).not.toBeInTheDocument()
  })

  test('closes the branch menu when Escape is pressed', async () => {
    mockDesktopWorkbenchMainWidth(1024)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...activeProjectState, currentRuntimeTask: activeProjectRuntimeTask }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
  })

  test('does not show environment info without an active project or runtime task', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+8',
      deletions: '-3',
      executionTarget: 'local' as const,
      deviceId: 'device-from-fallback',
      branchName: 'feature/fallback',
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [
            { id: 1, name: 'legacy', tasks: [] },
            {
              id: 2,
              name: 'workspace',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-from-fallback',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/repo',
                },
              },
            },
          ],
        }}
      />
    )

    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()
  })

  test('loads environment info automatically from the current runtime task workspace', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+2',
      deletions: '-0',
      executionTarget: 'local' as const,
      deviceId: 'runtime-device',
      branchName: 'runtime/worktree',
    })
    const onGetProjectWorkspaceRoot = vi.fn().mockResolvedValue('/workspace/projects')
    const runtimeProject = {
      id: 12,
      name: 'runtime-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'runtime-device',
        },
      },
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          currentRuntimeTask: {
            deviceId: 'runtime-device',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
          projects: [
            {
              id: 2,
              name: 'fallback',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'fallback-device',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/workspace/fallback',
                },
              },
            },
            runtimeProject,
          ],
          runtimeWork: {
            projects: [
              {
                project: { id: runtimeProject.id, name: runtimeProject.name },
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'runtime-device',
                    workspacePath: '/workspace/project-alpha',
                    available: true,
                    mapped: true,
                    tasks: [
                      {
                        taskId: 'runtime-1',
                        workspacePath: '/workspace/worktrees/8/project-alpha',
                        title: 'Runtime task',
                        runtime: 'codex',
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 1,
          },
        }}
      />
    )

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(runtimeProject, {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/8/project-alpha',
        source: 'runtime',
        taskId: 'runtime-1',
      })
    )
    expect(onGetProjectWorkspaceRoot).not.toHaveBeenCalled()
  })

  test('refreshes environment info after a runtime task finishes', async () => {
    const onLoadEnvironmentInfo = vi
      .fn()
      .mockResolvedValueOnce({
        additions: '+1',
        deletions: '-0',
        executionTarget: 'local' as const,
        deviceId: 'runtime-device',
        branchName: 'runtime/worktree',
      })
      .mockResolvedValueOnce({
        additions: '+8',
        deletions: '-2',
        executionTarget: 'local' as const,
        deviceId: 'runtime-device',
        branchName: 'runtime/worktree',
      })
    const runtimeProject = {
      id: 12,
      name: 'runtime-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: { targetType: 'local' as const, deviceId: 'runtime-device' },
      },
    }
    const runtimeTask = {
      deviceId: 'runtime-device',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-1',
    }
    const runtimeWork = {
      projects: [
        {
          project: { id: runtimeProject.id, name: runtimeProject.name },
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'runtime-device',
              workspacePath: '/workspace/project-alpha',
              available: true,
              mapped: true,
              tasks: [
                {
                  taskId: 'runtime-1',
                  workspacePath: '/workspace/worktrees/8/project-alpha',
                  title: 'Runtime task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const state = {
      ...baseProps.state,
      currentProject: null,
      currentRuntimeTask: runtimeTask,
      projects: [runtimeProject],
      runtimeWork,
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={state}
        lifecycleTaskRunning
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
      />
    )

    await waitFor(() => expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1))

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={state}
        lifecycleTaskRunning={false}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
      />
    )

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(2)
      expect(onLoadEnvironmentInfo).toHaveBeenLastCalledWith(
        runtimeProject,
        expect.objectContaining({ path: '/workspace/worktrees/8/project-alpha' }),
        { force: true }
      )
    })
  })

  test('loads environment info automatically for the current project workspace', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+4',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-1',
      branchName: 'feature/done',
    })
    const workspaceProject = {
      id: 1,
      name: 'workspace',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/repo',
        },
      },
    }
    const streamingMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Working',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[streamingMessage]}
      />
    )

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject, {
        deviceId: 'device-1',
        path: '/repo',
        source: 'project',
      })
    })

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[
          {
            ...streamingMessage,
            status: 'done' as const,
          },
        ]}
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
  })

  test('does not reload environment info when polling keeps the same workspace context', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+4',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-1',
      branchName: 'feature/done',
    })
    const workspaceProject = {
      id: 1,
      name: 'workspace',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/repo',
        },
      },
    }
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'project:1', id: 1, name: 'workspace' },
          deviceWorkspaces: [
            {
              id: 1,
              projectId: 1,
              deviceId: 'device-1',
              available: true,
              mapped: true,
              workspacePath: '/repo',
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          runtimeWork,
        }}
      />
    )

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject, {
        deviceId: 'device-1',
        path: '/repo',
        source: 'project',
      })
    })

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          devices: structuredClone(baseProps.state.devices),
          currentProject: workspaceProject,
          devices: structuredClone(baseProps.state.devices),
          runtimeWork: structuredClone(runtimeWork),
        }}
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
  })
})
