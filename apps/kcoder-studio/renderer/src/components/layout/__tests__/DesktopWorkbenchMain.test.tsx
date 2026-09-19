import '../DesktopWorkbenchLayout.test-mocks'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { WorkspaceFilePreview } from '../workspace-panels/WorkspaceFilePreview'
import { FileWorkspacePanel } from '../workspace-panels/FileWorkspacePanel'
import {
  DesktopWorkbenchLayout,
  baseProps,
  createDeferred,
} from '../DesktopWorkbenchLayout.test-harness'
import { getLocalPathKindMock } from '../DesktopWorkbenchLayout.test-mocks'
import {
  createCloudWorkspacePanelState,
  createLocalSkillDevice,
  getWorkspaceCodeViewSelectedLineNumbers,
  getWorkspaceCodeViewText,
  renderWorkspacePanelLayout,
} from '../DesktopWorkbenchMain.workspace.test-support'

describe('DesktopWorkbenchLayout', () => {
  test('project conversations open files from the project workspace', async () => {
    const workspaceProject = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'workspace-device',
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: 'projects/abc/Wegent',
        },
      },
    }
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/projects/abc/Wegent',
      entries: [],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
        messages={[
          {
            id: 'assistant-1',
            taskId: 99,
            role: 'assistant',
            content: 'stale task output',
            status: 'done',
            createdAt: '2026-06-12T00:00:00.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-file-changes/99/100',
              device_id: 'workspace-device',
              workspace_path: '/Users/me/outside-workspace',
              file_count: 0,
              additions: 0,
              deletions: 0,
              files: [],
            },
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
          currentProjectId: workspaceProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-device',
        '/workspace/projects/abc/Wegent'
      )
    )
  })

  test('right workspace panel opens only the review tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const reviewTab = screen.getByTestId('right-workspace-review-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(reviewTab).toHaveAttribute('role', 'tab')
    expect(reviewTab).toHaveAttribute('aria-selected', 'true')
    expect(reviewTab).toHaveTextContent('审查')
    expect(screen.queryByTestId('right-workspace-file-tab')).not.toBeInTheDocument()
    const closeButton = within(reviewTab).getByTestId('right-workspace-review-tab-close-button')
    expect(reviewTab).toHaveClass('group/tab')
    expect(closeButton.parentElement).toHaveClass(
      'absolute',
      'right-1',
      'opacity-0',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton).toHaveClass(
      'h-[18px]',
      'w-[18px]',
      'rounded-full',
      'hover:bg-black/70',
      'hover:text-white'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(closeButton).not.toHaveClass('border', 'bg-muted')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('refresh-review-diff-button'))

    await waitFor(() => expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
  })

  test('right workspace panel retries review loading after a stale device offline error', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockRejectedValueOnce(new Error("Device 'aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a' is offline"))
      .mockResolvedValueOnce(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const failedPanel = await screen.findByTestId('file-changes-review-panel')
    expect(failedPanel).toHaveTextContent('设备暂时不可用，请稍后重试')
    expect(failedPanel).not.toHaveTextContent('aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a')
    expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(
      within(screen.getByTestId('right-workspace-review-tab')).getByTestId(
        'right-workspace-review-tab-close-button'
      )
    )
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    await waitFor(() => expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('new')
    expect(screen.getByTestId('file-changes-review-panel')).not.toHaveTextContent(
      '设备暂时不可用，请稍后重试'
    )
  })

  test('right workspace panel shows file tree and read-only preview', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValueOnce({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))

    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await user.click(await screen.findByText('README.md'))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('hello world'))
    expect(getWorkspaceCodeViewText()).toContain('/workspace/project/README.md')
  })

  test('switches folders in the file tab for a multi-root project', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const runtimeWork = {
      projects: [
        {
          project: { id: workspacePanelState.currentProject.id, name: 'workspace-project' },
          deviceWorkspaces: [
            {
              id: 301,
              deviceId: 'workspace-cloud-device',
              workspacePath: '/workspace/web',
              workspaceSource: 'local' as const,
              available: true,
              tasks: [],
            },
            {
              id: 302,
              deviceId: 'workspace-cloud-device',
              workspacePath: '/workspace/api',
              workspaceSource: 'local' as const,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const listWorkspaceEntries = vi.fn().mockImplementation((_deviceId, path) =>
      Promise.resolve({
        path,
        entries: [],
      })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          runtimeWork,
          selectedDeviceWorkspaceId: 301,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
          selectedDeviceWorkspaceId: 301,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))

    expect(await screen.findByTestId('workspace-file-root-selector')).toHaveTextContent('web')
    await user.click(screen.getByTestId('workspace-file-root-selector'))
    await user.click(screen.getByTitle('/workspace/api'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith('workspace-cloud-device', '/workspace/api')
    )
    expect(screen.getByTestId('workspace-file-root-selector')).toHaveTextContent('api')
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/api')
  })

  test('opens an edited file from the conversation tool block in the workspace panel', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'opened from tool block',
      truncated: false,
      size: 22,
      modifiedAt: null,
    })
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'assistant-editing-file',
            taskId: 101,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
            blocks: [
              {
                id: 'edit-file-1',
                subtaskId: 101,
                type: 'tool',
                toolName: 'edit_file',
                toolInput: {
                  path: 'README.md',
                  old_string: 'before',
                  new_string: 'after',
                },
                status: 'streaming',
                createdAt: 1770000000000,
              },
            ],
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /正在编辑 README\.md/ }))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('opened from tool block'))
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workspace-file-tree-container')).toHaveClass(
      'pointer-events-none',
      'w-0',
      'opacity-0'
    )
    expect(screen.getByTestId('workspace-file-toggle-tree-button')).toHaveAccessibleName(
      '显示目录树'
    )

    await user.click(screen.getByTestId('workspace-file-toggle-tree-button'))

    expect(screen.getByTestId('workspace-file-tree-container')).toHaveClass(
      'w-[240px]',
      'opacity-100'
    )
    expect(screen.getByTestId('workspace-file-toggle-tree-button')).toHaveAccessibleName(
      '隐藏目录树'
    )
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/project/README.md'
    )
  })

  test('opens a markdown directory link in the workspace tree without reading it as a file', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    getLocalPathKindMock.mockResolvedValue('directory')
    const listWorkspaceEntries = vi.fn().mockImplementation((_deviceId, path) =>
      Promise.resolve({
        path,
        entries:
          path === '/workspace/project'
            ? [
                {
                  name: 'docs',
                  path: '/workspace/project/docs',
                  isDirectory: true,
                  size: 0,
                  modifiedAt: null,
                },
              ]
            : [],
      })
    )
    const readWorkspaceTextFile = vi.fn()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'assistant-directory-link',
            role: 'assistant',
            content: '[docs](/workspace/project/docs)',
            status: 'done',
            createdAt: '2026-07-25T08:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(screen.getByTestId('assistant-markdown-link'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project/docs'
      )
    )
    expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/project/docs')
    expect(screen.getByTestId('workspace-file-tree-container')).toHaveClass(
      'w-[240px]',
      'opacity-100'
    )
    expect(readWorkspaceTextFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/无法加载|Failed to load/i)).not.toBeInTheDocument()
  })

  test('opens a local image link on the local device while the project workspace is remote', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const localDevice = createLocalSkillDevice()
    const imagePath = '/Users/me/.wegent-executor/workspace/attachments/draft/42/result.png'
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/Users/me/.wegent-executor/workspace/attachments/draft/42',
      entries: [],
    })
    const readWorkspaceFileChunk = vi.fn().mockResolvedValue({
      path: imagePath,
      name: 'result.png',
      contentBase64: 'aW1hZ2U=',
      offset: 0,
      size: 5,
      eof: true,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
          readWorkspaceFileChunk,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          devices: [...workspacePanelState.devices, localDevice],
        }}
        messages={[
          {
            id: 'assistant-local-image-link',
            role: 'assistant',
            content: `[result.png](${imagePath})`,
            status: 'done',
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: [...workspacePanelState.devices, localDevice],
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(await screen.findByTestId('assistant-markdown-link'))

    expect(await screen.findByTestId('workspace-binary-file-preview')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(listWorkspaceEntries).toHaveBeenCalledWith(
      localDevice.device_id,
      '/Users/me/.wegent-executor/workspace/attachments/draft/42'
    )
    expect(readWorkspaceFileChunk).toHaveBeenCalledWith(localDevice.device_id, imagePath, 0)
  })

  test('opens a skill from the empty composer on the real local device', async () => {
    const user = userEvent.setup()
    const localDevice = createLocalSkillDevice()
    const skillPath = '/Users/me/.agents/skills/gmail/SKILL.md'
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/Users/me/.agents/skills/gmail',
      entries: [],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: skillPath,
      name: 'SKILL.md',
      content: '# Gmail',
      truncated: false,
      size: 7,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        state={{
          ...baseProps.state,
          devices: [localDevice],
          input: `[$gmail](${skillPath}) `,
        }}
        projectWork={{
          ...baseProps.projectWork,
          devices: [localDevice],
        }}
      />
    )

    await user.click(await screen.findByTestId('local-skill-chip-gmail'))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(listWorkspaceEntries).toHaveBeenCalledWith(
      localDevice.device_id,
      '/Users/me/.agents/skills/gmail'
    )
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(localDevice.device_id, skillPath)
  })

  test('opens a sent skill on the local device while the project workspace is remote', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const localDevice = createLocalSkillDevice()
    const skillPath = '/Users/me/.agents/skills/gmail/SKILL.md'
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/Users/me/.agents/skills/gmail',
      entries: [],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: skillPath,
      name: 'SKILL.md',
      content: '# Gmail',
      truncated: false,
      size: 7,
      modifiedAt: null,
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          devices: [...workspacePanelState.devices, localDevice],
        }}
        messages={[
          {
            id: 'user-skill-link',
            role: 'user',
            content: `[$gmail](${skillPath})`,
            status: 'completed',
            createdAt: '2026-07-11T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: [...workspacePanelState.devices, localDevice],
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(await screen.findByTestId('sent-local-skill-token-gmail'))

    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(listWorkspaceEntries).toHaveBeenCalledWith(
      localDevice.device_id,
      '/Users/me/.agents/skills/gmail'
    )
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(localDevice.device_id, skillPath)
    expect(readWorkspaceTextFile).not.toHaveBeenCalledWith(
      workspacePanelState.devices[0].device_id,
      skillPath
    )
  })

  test('right workspace panel renders nested directories as an expanded tree', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/backend') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: 'alembic',
              path: '/workspace/project/backend/alembic',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'app',
              path: '/workspace/project/backend/app',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
          ],
        })
      }
      if (path === '/workspace/project/backend/alembic') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: '__pycache__',
              path: '/workspace/project/backend/alembic/__pycache__',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'env.py',
              path: '/workspace/project/backend/alembic/env.py',
              isDirectory: false,
              size: 24,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'backend',
            path: '/workspace/project/backend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'frontend',
            path: '/workspace/project/frontend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('backend'))

    const backendRow = screen
      .getByText('backend')
      .closest('[data-testid="workspace-directory-row"]')
    const alembicRow = await screen.findByText('alembic')
    expect(backendRow).toHaveAttribute('aria-expanded', 'true')
    expect(backendRow).toHaveAttribute('data-depth', '0')
    expect(alembicRow.closest('[data-testid="workspace-directory-row"]')).toHaveAttribute(
      'data-depth',
      '1'
    )
    expect(screen.getByText('frontend')).toBeInTheDocument()

    await user.click(alembicRow)

    const selectedAlembicRow = screen
      .getByText('alembic')
      .closest('[data-testid="workspace-directory-row"]')
    expect(selectedAlembicRow).toHaveClass('ring-1', 'ring-primary')
    expect(await screen.findByText('__pycache__')).toBeInTheDocument()
    expect(
      screen.getByText('env.py').closest('[data-testid="workspace-file-row"]')
    ).toHaveAttribute('data-depth', '2')
    expect(screen.getAllByTestId('workspace-tree-indent-guide').length).toBeGreaterThan(0)
  })

  test('right workspace panel ignores stale file preview responses', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readmeFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const notesFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 12,
          modifiedAt: null,
        },
        {
          name: 'NOTES.md',
          path: '/workspace/project/NOTES.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn((_deviceId: string, path: string) =>
      path.endsWith('README.md') ? readmeFile.promise : notesFile.promise
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('README.md'))
    await user.click(screen.getByText('NOTES.md'))

    await act(async () => {
      notesFile.resolve({
        path: '/workspace/project/NOTES.md',
        name: 'NOTES.md',
        content: 'notes first',
        truncated: false,
        size: 11,
        modifiedAt: null,
      })
    })
    expect(await screen.findByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('notes first'))

    await act(async () => {
      readmeFile.resolve({
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: 'readme stale',
        truncated: false,
        size: 12,
        modifiedAt: null,
      })
    })

    expect(getWorkspaceCodeViewText()).toContain('notes first')
    expect(getWorkspaceCodeViewText()).not.toContain('readme stale')
  })

  test('right workspace panel ignores stale directory responses', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const srcTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const docsTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') return srcTree.promise
      if (path === '/workspace/project/docs') return docsTree.promise
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'docs',
            path: '/workspace/project/docs',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    const srcButton = (await screen.findByText('src')).closest('button')
    expect(srcButton).not.toBeNull()
    fireEvent.click(srcButton as HTMLButtonElement)
    // A controlled selection change rebuilds the Pierre model; obtain the next item from the current DOM as a user would.
    fireEvent.click(screen.getByText('docs').closest('button') as HTMLButtonElement)

    await act(async () => {
      docsTree.resolve({
        path: '/workspace/project/docs',
        entries: [
          {
            name: 'guide.md',
            path: '/workspace/project/docs/guide.md',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })
    expect(await screen.findByText('guide.md')).toBeInTheDocument()

    await act(async () => {
      srcTree.resolve({
        path: '/workspace/project/src',
        entries: [
          {
            name: 'main.ts',
            path: '/workspace/project/src/main.ts',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })

    expect(screen.getByText('docs').closest('[data-testid="workspace-directory-row"]')).toHaveClass(
      'ring-1',
      'ring-primary'
    )
    expect(screen.getByText('guide.md')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
  })

  test('right workspace panel retries the failed directory path', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    let srcAttempts = 0
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') {
        srcAttempts += 1
        if (srcAttempts === 1) {
          return Promise.reject(new Error('src failed'))
        }
        return Promise.resolve({
          path: '/workspace/project/src',
          entries: [
            {
              name: 'main.ts',
              path: '/workspace/project/src/main.ts',
              isDirectory: false,
              size: 12,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        workspaceFileApi={{
          ...baseProps.workspaceFileApi,
          listWorkspaceEntries,
        }}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('src'))
    expect(await screen.findByText('src failed')).toBeInTheDocument()

    await user.click(screen.getByTestId('workspace-file-tree-retry-button'))

    expect(await screen.findByText('main.ts')).toBeInTheDocument()
    expect(listWorkspaceEntries).toHaveBeenLastCalledWith(
      'workspace-cloud-device',
      '/workspace/project/src'
    )
  })

  test('right workspace panel keeps the same tree for unrelated message updates', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })
    const layoutProps = {
      ...baseProps,
      workspaceFileApi: {
        ...baseProps.workspaceFileApi,
        listWorkspaceEntries,
      },
      state: {
        ...baseProps.state,
        ...workspacePanelState,
      },
      projectWork: {
        ...baseProps.projectWork,
        projects: workspacePanelState.projects,
        devices: workspacePanelState.devices,
        currentProjectId: workspacePanelState.currentProject?.id,
      },
    }

    const { rerender } = render(<DesktopWorkbenchLayout {...layoutProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await waitFor(() => expect(listWorkspaceEntries).toHaveBeenCalledTimes(1))

    rerender(
      <DesktopWorkbenchLayout
        {...layoutProps}
        messages={[
          {
            id: 'message-update',
            role: 'assistant',
            content: 'streaming content changed',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
          },
        ]}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listWorkspaceEntries).toHaveBeenCalledTimes(1)
  })

  test('workspace file preview stays mounted when equivalent dependencies get new references', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 12,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'stable preview content',
      truncated: false,
      size: 22,
      modifiedAt: null,
    })
    const target = {
      deviceId: 'workspace-cloud-device',
      path: '/workspace/project',
      source: 'project' as const,
      workspaceSource: 'remote',
    }
    const { rerender } = render(
      <FileWorkspacePanel
        target={target}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        onAddCodeComment={vi.fn()}
      />
    )

    await user.click(await screen.findByText('README.md'))
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('stable preview content'))

    rerender(
      <FileWorkspacePanel
        target={{ ...target }}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        onAddCodeComment={vi.fn()}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    expect(listWorkspaceEntries).toHaveBeenCalledTimes(1)
    expect(readWorkspaceTextFile).toHaveBeenCalledTimes(1)
  })

  test('workspace file search finds and opens files inside collapsed directories', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
        },
      ],
    })
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({
      files: [
        {
          root: '/workspace/project',
          path: 'src/calculator.js',
          fileName: 'calculator.js',
          matchType: 'file',
          score: 100,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/src/calculator.js',
      name: 'calculator.js',
      content: 'export const add = (left, right) => left + right',
      editable: true,
      revision: 'sha256:calculator',
      truncated: false,
      size: 48,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          searchWorkspaceEntries,
          readWorkspaceTextFile,
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await screen.findByText('src')
    await user.type(screen.getByTestId('workspace-file-search-input'), 'calculator.js')

    await waitFor(() =>
      expect(searchWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project',
        'calculator.js',
        expect.any(String)
      )
    )
    await user.click(await screen.findByText('calculator.js'))

    await waitFor(() =>
      expect(readWorkspaceTextFile).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project/src/calculator.js'
      )
    )
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('export const add'))
  })

  test('workspace file search shows an empty result and restores the tree when cleared', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 5,
        },
      ],
    })
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({ files: [] })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{ listWorkspaceEntries, searchWorkspaceEntries }}
        onAddCodeComment={vi.fn()}
      />
    )

    await screen.findByText('README.md')
    const searchInput = screen.getByTestId('workspace-file-search-input')
    await user.type(searchInput, 'missing-file')

    expect(await screen.findByTestId('workspace-file-search-empty')).toHaveTextContent(
      '没有匹配的文件'
    )
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()

    await user.clear(searchInput)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-file-search-empty')).not.toBeInTheDocument()
  })

  test('workspace file panel edits and saves an editable text file', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 5,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello',
      editable: true,
      revision: 'sha256:old',
      truncated: false,
      size: 5,
      modifiedAt: null,
    })
    const writeWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      editable: true,
      revision: 'sha256:new',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
          writeWorkspaceTextFile,
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await user.click(await screen.findByText('README.md'))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-edit-button')).toBeInTheDocument()
    )

    await user.click(screen.getByTestId('workspace-file-edit-button'))
    const editor = screen.getByTestId('workspace-file-editor')
    const codeMirrorContent = editor.querySelector('.cm-content')
    expect(codeMirrorContent).toBeInstanceOf(HTMLElement)

    await user.click(codeMirrorContent as HTMLElement)
    await user.keyboard('{Control>}a{/Control}hello world')
    await user.click(screen.getByTestId('workspace-file-save-button'))

    await waitFor(() =>
      expect(writeWorkspaceTextFile).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project/README.md',
        'hello world',
        'sha256:old'
      )
    )
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-file-editor')).not.toBeInTheDocument()
      expect(screen.queryByTestId('workspace-file-save-button')).not.toBeInTheDocument()
      expect(screen.getByTestId('workspace-file-edit-button')).toBeInTheDocument()
      expect(screen.getByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    })
  })

  test('workspace file panel creates, renames, and deletes entries', async () => {
    const user = userEvent.setup()
    let entries = [
      {
        name: 'README.md',
        path: '/workspace/project/README.md',
        isDirectory: false,
        size: 5,
      },
    ]
    const listWorkspaceEntries = vi.fn(async () => ({
      path: '/workspace/project',
      entries,
    }))
    const readWorkspaceTextFile = vi.fn(async (_deviceId: string, path: string) => ({
      path,
      name: path.split('/').at(-1) ?? path,
      content: '',
      editable: true,
      revision: 'sha256:empty',
      truncated: false,
      size: 0,
    }))
    const createWorkspaceTextFile = vi.fn(
      async (_deviceId: string, parentPath: string, name: string) => {
        const created = { name, path: `${parentPath}/${name}`, isDirectory: false, size: 0 }
        entries = [...entries, created]
        return {
          ...created,
          content: '',
          editable: true,
          revision: 'sha256:empty',
          truncated: false,
        }
      }
    )
    const createWorkspaceDirectory = vi.fn(
      async (_deviceId: string, parentPath: string, name: string) => {
        const created = { name, path: `${parentPath}/${name}`, isDirectory: true, size: 0 }
        entries = [...entries, created]
        return created
      }
    )
    const renameWorkspaceEntry = vi.fn(
      async (_deviceId: string, parentPath: string, name: string, newName: string) => {
        const renamed = {
          name: newName,
          path: `${parentPath}/${newName}`,
          isDirectory: false,
          size: 0,
        }
        entries = entries.map(entry => (entry.name === name ? renamed : entry))
        return renamed
      }
    )
    const deleteWorkspaceEntry = vi.fn(
      async (_deviceId: string, _parentPath: string, name: string) => {
        entries = entries.filter(entry => entry.name !== name)
      }
    )

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
          createWorkspaceTextFile,
          createWorkspaceDirectory,
          renameWorkspaceEntry,
          deleteWorkspaceEntry,
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await screen.findByText('README.md')
    await user.click(screen.getByTestId('workspace-file-create-file-button'))
    await user.type(screen.getByTestId('workspace-file-entry-name-input'), 'scratch.txt')
    await user.click(screen.getByTestId('workspace-file-entry-confirm-button'))
    await waitFor(() =>
      expect(createWorkspaceTextFile).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project',
        'scratch.txt',
        ''
      )
    )

    await user.click(await screen.findByTestId('workspace-file-rename-button'))
    const renameInput = screen.getByTestId('workspace-file-entry-name-input')
    await user.clear(renameInput)
    await user.type(renameInput, 'renamed.txt')
    await user.click(screen.getByTestId('workspace-file-entry-confirm-button'))
    await waitFor(() =>
      expect(renameWorkspaceEntry).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project',
        'scratch.txt',
        'renamed.txt'
      )
    )

    await user.click(screen.getByTestId('workspace-file-create-directory-button'))
    await user.type(screen.getByTestId('workspace-file-entry-name-input'), 'src-new')
    await user.click(screen.getByTestId('workspace-file-entry-confirm-button'))
    await waitFor(() =>
      expect(createWorkspaceDirectory).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project',
        'src-new'
      )
    )

    await user.click(screen.getByTestId('workspace-file-delete-button'))
    expect(screen.getByTestId('workspace-file-delete-dialog')).toHaveTextContent(
      '/workspace/project/src-new'
    )
    await user.click(screen.getByTestId('workspace-file-delete-confirm-button'))
    await waitFor(() =>
      expect(deleteWorkspaceEntry).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project',
        'src-new',
        true
      )
    )
  })

  test('workspace file unsaved guard can reopen after cancelling the same navigation', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'calculator.js',
          path: '/workspace/project/calculator.js',
          isDirectory: false,
          size: 20,
        },
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 8,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn(async (_deviceId: string, path: string) => ({
      path,
      name: path.split('/').at(-1) ?? path,
      content: path.endsWith('calculator.js') ? 'export const add = 1' : '# readme',
      editable: true,
      revision: `sha256:${path}`,
      truncated: false,
      size: 20,
    }))

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-cloud-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile,
          writeWorkspaceTextFile: vi.fn(),
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await user.click(await screen.findByText('calculator.js'))
    await screen.findByTestId('workspace-file-edit-button')
    await user.click(screen.getByTestId('workspace-file-edit-button'))
    const codeMirrorContent = screen
      .getByTestId('workspace-file-editor')
      .querySelector('.cm-content')
    expect(codeMirrorContent).toBeInstanceOf(HTMLElement)
    await user.click(codeMirrorContent as HTMLElement)
    await user.keyboard('{Control>}a{/Control}unsaved calculator change')

    await user.click(screen.getByText('README.md'))
    expect(await screen.findByTestId('workspace-file-unsaved-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('workspace-file-unsaved-cancel'))
    expect(screen.queryByTestId('workspace-file-unsaved-dialog')).not.toBeInTheDocument()

    await user.click(screen.getByText('README.md'))
    expect(await screen.findByTestId('workspace-file-unsaved-dialog')).toBeInTheDocument()
    expect(readWorkspaceTextFile).not.toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/project/README.md'
    )
  })

  test('workspace file preview renders file contents with Pierre file viewer', async () => {
    render(
      <WorkspaceFilePreview
        file={{
          path: '/workspace/project/repeat.txt',
          name: 'repeat.txt',
          content: 'repeat\nmiddle\nrepeat',
          truncated: false,
          size: 20,
          modifiedAt: null,
        }}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    expect(screen.getByTestId('workspace-file-preview-code-view')).toBeInTheDocument()
    expect(
      screen.getByTestId('workspace-file-preview-code-view').querySelector('div')
    ).toBeInTheDocument()
    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('repeat'))
  })

  test('workspace file preview selects the requested target line', async () => {
    render(
      <WorkspaceFilePreview
        file={{
          path: '/workspace/project/repeat.txt',
          name: 'repeat.txt',
          content: 'first\nsecond\nthird',
          truncated: false,
          size: 18,
          modifiedAt: null,
        }}
        loading={false}
        targetLineStart={2}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(getWorkspaceCodeViewSelectedLineNumbers()).toContain('2'))
    expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  })

  test('workspace file preview swaps Pierre viewer when file changes', async () => {
    const firstFile = {
      path: '/workspace/project/first.txt',
      name: 'first.txt',
      content: 'first file',
      truncated: false,
      size: 10,
      modifiedAt: null,
    }
    const secondFile = {
      path: '/workspace/project/second.txt',
      name: 'second.txt',
      content: 'second file',
      truncated: false,
      size: 11,
      modifiedAt: null,
    }
    const { rerender } = render(
      <WorkspaceFilePreview
        file={firstFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('first file'))

    rerender(
      <WorkspaceFilePreview
        file={secondFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(getWorkspaceCodeViewText()).toContain('second file'))
    expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  })
})
