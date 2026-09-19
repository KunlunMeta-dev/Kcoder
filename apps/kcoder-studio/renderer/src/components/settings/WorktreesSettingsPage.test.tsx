import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/devices'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'
import '@/i18n'

describe('WorktreesSettingsPage', () => {
  const getWorktreeSettings = vi.fn()
  const updateWorktreeSettings = vi.fn()
  const listWorktrees = vi.fn()
  const previewWorktreeArchive = vi.fn()
  const archiveWorktree = vi.fn()
  const restoreWorktree = vi.fn()
  const forgetWorktree = vi.fn()

  const api = {
    getWorktreeSettings,
    updateWorktreeSettings,
    listWorktrees,
    previewWorktreeArchive,
    archiveWorktree,
    restoreWorktree,
    forgetWorktree,
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>

  const devices = [
    {
      id: 1,
      device_id: 'local-device',
      name: 'This Mac',
      status: 'online',
      device_type: 'local',
      bind_shell: 'codex',
      is_default: true,
    },
  ] as DeviceInfo[]

  beforeEach(() => {
    vi.clearAllMocks()
    getWorktreeSettings.mockResolvedValue({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wecode/wegent-executor/workspace/worktrees',
      autoCleanupEnabled: true,
      keepCount: 15,
    })
    updateWorktreeSettings.mockImplementation(async data => ({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wecode/wegent-executor/workspace/worktrees',
      autoCleanupEnabled: data.autoCleanupEnabled ?? true,
      keepCount: data.keepCount ?? 15,
    }))
    listWorktrees.mockResolvedValue({
      success: true,
      deviceId: 'local-device',
      items: [
        {
          deviceId: 'local-device',
          worktreeId: 'runtime-1',
          path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
          repositoryName: 'repo',
          sourcePath: '/Users/me/repo',
          revision: 3,
          state: 'active',
          conversations: [
            {
              deviceId: 'local-device',
              taskId: 'runtime-1',
              workspacePath: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
              title: 'Fix settings',
              status: 'active',
              running: false,
            },
          ],
        },
      ],
    })
    previewWorktreeArchive.mockResolvedValue({
      success: true,
      deviceId: 'local-device',
      preview: {
        path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
        state: 'active',
        revision: 3,
        contentToken: 'tree-token',
        dirty: true,
        untrackedFileCount: 1,
        ignoredEntryCount: 0,
        dirtySubmoduleCount: 0,
        nestedRepositoryCount: 0,
        baselineKnown: true,
        commitsSinceCreation: 1,
        requiresConfirmation: true,
        archiveAllowed: true,
        blockingReasons: [],
      },
    })
    archiveWorktree.mockResolvedValue({ success: true, worktree: { revision: 5 } })
    restoreWorktree.mockResolvedValue({ success: true })
    forgetWorktree.mockResolvedValue({ success: true })
  })

  test('loads device defaults and linked tasks from the injected device API', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)

    expect(await screen.findByTestId('worktrees-settings-page')).toBeInTheDocument()
    await waitFor(() =>
      expect(getWorktreeSettings).toHaveBeenCalledWith({ deviceId: 'local-device' })
    )
    expect(screen.getByTestId('worktrees-auto-cleanup-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(15)
    expect(screen.getByText('Fix settings')).toBeInTheDocument()
  })

  test('a slow old target cannot replace the new target settings or carry its draft across', async () => {
    let finishOld!: (value: unknown) => void
    const old = new Promise(resolve => {
      finishOld = resolve
    })
    getWorktreeSettings.mockImplementation(({ deviceId }) =>
      deviceId === 'local-device'
        ? old
        : Promise.resolve({
            deviceId,
            worktreeRoot: '/remote-root',
            resolvedWorktreeRoot: '/remote-root',
            autoCleanupEnabled: true,
            keepCount: 7,
          })
    )
    listWorktrees.mockResolvedValue({ success: true, items: [] })
    render(
      <WorktreesSettingsPage
        api={api}
        devices={[...devices, { device_id: 'remote', name: 'Remote', status: 'online' }]}
      />
    )
    await waitFor(() =>
      expect(getWorktreeSettings).toHaveBeenCalledWith({ deviceId: 'local-device' })
    )
    await userEvent.selectOptions(screen.getByTestId('worktrees-device-select'), 'remote')
    await waitFor(() => expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(7))
    await act(async () =>
      finishOld({
        deviceId: 'local-device',
        worktreeRoot: '/old-root',
        resolvedWorktreeRoot: '/old-root',
        autoCleanupEnabled: false,
        keepCount: 42,
      })
    )
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(7)
    expect(screen.getByTestId('worktrees-device-select')).toHaveValue('remote')
    expect(screen.queryByDisplayValue('/old-root')).not.toBeInTheDocument()
    expect(updateWorktreeSettings).not.toHaveBeenCalled()
  })

  test('groups projects and opens a linked conversation', async () => {
    const onOpenRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const onRefreshWorkLists = vi.fn().mockResolvedValue(undefined)
    const onLeaveSettings = vi.fn()
    render(
      <WorktreesSettingsPage
        api={api}
        devices={devices}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onRefreshWorkLists={onRefreshWorkLists}
        onLeaveSettings={onLeaveSettings}
      />
    )

    const projectHeader = await screen.findByTestId('worktree-project-header')
    expect(projectHeader).toHaveTextContent('/Users/me/repo')
    expect(projectHeader).toContainElement(screen.getByTestId('worktrees-refresh-button'))
    expect(screen.queryByText('已管理的工作树')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('worktree-row')).getByText('工作树')).toBeInTheDocument()
    expect(screen.getByText('对话')).toBeInTheDocument()
    expect(screen.getByTestId('archive-worktree-button-runtime-1')).toHaveTextContent('归档')

    await userEvent.click(screen.getByTestId('worktree-linked-task'))
    await waitFor(() =>
      expect(onOpenRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'local-device', taskId: 'runtime-1' })
      )
    )
    expect(onRefreshWorkLists).toHaveBeenCalledTimes(1)
    expect(onLeaveSettings).toHaveBeenCalledTimes(1)
  })

  test('shows restorable snapshots with restore and permanent-delete actions', async () => {
    listWorktrees.mockResolvedValueOnce({
      success: true,
      deviceId: 'local-device',
      items: [
        {
          deviceId: 'local-device',
          worktreeId: 'runtime-restorable',
          path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/restorable/repo',
          repositoryName: 'repo',
          sourcePath: '/Users/me/repo',
          revision: 5,
          state: 'restorable',
          conversations: [],
        },
      ],
    })

    render(<WorktreesSettingsPage api={api} devices={devices} />)

    expect(await screen.findByText(/worktrees\/restorable/)).toBeInTheDocument()
    expect(screen.getByTestId('restore-worktree-button-runtime-restorable')).toBeInTheDocument()
    expect(screen.getByTestId('forget-worktree-button-runtime-restorable')).toBeInTheDocument()
  })

  test('updates cleanup settings and archives through preview plus explicit confirmation', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')

    const cleanupSwitch = screen.getByTestId('worktrees-auto-cleanup-switch')
    expect(cleanupSwitch.querySelector('span')).toHaveClass('h-5', 'w-8', 'overflow-hidden')
    expect(cleanupSwitch.querySelector('span span')).toHaveClass('translate-x-[14px]')
    await userEvent.click(cleanupSwitch)
    expect(screen.getByTestId('disable-worktree-cleanup-dialog')).toBeInTheDocument()
    expect(updateWorktreeSettings).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('disable-worktree-cleanup-button'))
    await waitFor(() =>
      expect(updateWorktreeSettings).toHaveBeenCalledWith({
        deviceId: 'local-device',
        autoCleanupEnabled: false,
      })
    )
    expect(screen.getByTestId('worktrees-saved-notice')).toHaveTextContent('已保存自动删除设置')
    expect(cleanupSwitch).toHaveAttribute('aria-checked', 'false')
    expect(cleanupSwitch.querySelector('span span')).toHaveClass('translate-x-0.5')

    await userEvent.click(screen.getByTestId('archive-worktree-button-runtime-1'))
    await waitFor(() =>
      expect(previewWorktreeArchive).toHaveBeenCalledWith({
        deviceId: 'local-device',
        path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
      })
    )
    expect(screen.getByTestId('archive-worktree-dialog')).toBeInTheDocument()
    expect(archiveWorktree).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-archive-worktree-button'))
    await waitFor(() =>
      expect(archiveWorktree).toHaveBeenCalledWith({
        deviceId: 'local-device',
        path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
        expectedRevision: 3,
        expectedContentToken: 'tree-token',
        riskAccepted: true,
      })
    )
    expect(listWorktrees).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('worktrees-auto-cleanup-switch')).toBeInTheDocument()
  })

  test('saves the cleanup limit on Enter without reloading the list', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')
    expect(listWorktrees).toHaveBeenCalledTimes(1)

    const input = screen.getByTestId('worktrees-keep-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '20{Enter}')

    await waitFor(() =>
      expect(updateWorktreeSettings).toHaveBeenCalledWith({
        deviceId: 'local-device',
        keepCount: 20,
      })
    )
    expect(screen.getByTestId('worktrees-saved-notice')).toHaveTextContent('已保存自动删除限制')
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })
})
