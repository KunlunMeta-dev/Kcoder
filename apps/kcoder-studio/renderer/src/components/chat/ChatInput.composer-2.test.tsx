import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
import { projectWorkControls, runtimeWork } from './composer/ChatInput.test-support'
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { action?: string; count?: number; device?: string; location?: string },
      interpolation?: { model?: string }
    ) => {
      if (typeof options === 'string') {
        return interpolation?.model ? options.replace('{{model}}', interpolation.model) : options
      }
      if (key === 'workbench.goal_standard_label') return '普通目标（/goal）'
      if (key === 'workbench.goal_pro_label') return '严格目标（/goal-pro）'
      if (key === 'workbench.goal_pro_description') return '持续执行目标，并进行独立验证'
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.environment_cloud_device') return '云设备'
      if (key === 'workbench.environment_local') return '本机'
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))
describe('ChatInput composer', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalInnerWidth = window.innerWidth
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })
  test('renders remote project IPs and hides local device names in the project menu', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([
            {
              id: 7,
              name: 'Wegent',
              workspaceId: 70,
              deviceId: 'device-online',
              deviceName: '203.0.113.10',
            },
            {
              id: 8,
              name: 'Docs',
              workspaceId: 80,
              deviceId: 'device-local',
              deviceName: 'Local Device',
            },
          ]),
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              client_ip: '203.0.113.10',
            },
            {
              id: 2,
              device_id: 'device-local',
              name: 'Local Device',
              status: 'online',
              is_default: false,
              device_type: 'local',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const projectDeviceLabel = screen.getAllByText('203.0.113.10')[0]
    expect(projectDeviceLabel).toHaveClass('text-text-secondary')
    expect(projectDeviceLabel).not.toHaveClass('text-primary')
    expect(
      within(screen.getByTestId('project-option-8')).queryByText('Local Device')
    ).not.toBeInTheDocument()
  })

  test('ignores the projects table when runtime work is empty', async () => {
    const onSelectProject = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            { id: 7, name: 'Online Project', tasks: [] },
            { id: 8, name: 'Offline Project', tasks: [] },
          ],
          runtimeWork: runtimeWork([]),
          onSelectProject,
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
            },
            {
              id: 2,
              device_id: 'device-offline',
              name: 'offline-executor',
              status: 'offline',
              is_default: false,
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByText('暂无项目')).toBeInTheDocument()
    expect(screen.queryByTestId('project-option-7')).not.toBeInTheDocument()
    expect(screen.queryByText('Online Project')).not.toBeInTheDocument()
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  test('limits the desktop worktree branch menu while branches scroll', async () => {
    const branches = Array.from({ length: 50 }, (_, index) => `feature/branch-${index}`)
    const worktreeProject = {
      id: 7,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/wegent',
        },
      },
    }
    vi.stubGlobal('innerHeight', 380)

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [worktreeProject],
          currentProject: worktreeProject,
          currentProjectId: 7,
          isGitProject: true,
          executionMode: 'git_worktree',
          executionModeLocked: false,
          onExecutionModeChange: vi.fn(),
          branchName: 'main',
          branchLoading: false,
          onListBranches: vi.fn().mockResolvedValue(branches),
          worktreeBranch: null,
          onWorktreeBranchChange: vi.fn(),
        })}
      />
    )

    const branchButton = screen.getByTestId('project-worktree-branch-button')
    vi.spyOn(branchButton, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 300,
      left: 0,
      top: 300,
      right: 120,
      bottom: 336,
      width: 120,
      height: 36,
      toJSON: () => ({}),
    })

    await userEvent.click(branchButton)

    const menu = await screen.findByTestId('project-worktree-branch-menu')
    await waitFor(() => expect(menu).toHaveStyle({ maxHeight: '276px' }))
    expect(menu).toHaveClass('bottom-11', 'overflow-hidden')
    expect(screen.getByTestId('project-worktree-branch-list')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
    expect(await screen.findAllByTestId('project-worktree-branch-option')).toHaveLength(50)
  })

  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })
})
