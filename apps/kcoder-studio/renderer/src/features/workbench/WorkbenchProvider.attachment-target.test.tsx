import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from './WorkbenchProvider'
import {
  clearGatewayRuntime,
  createDevice,
  createProject,
  createRuntimeWorkApiMock,
  createWorkbenchServices,
  renderWorkbench,
  setGatewayRuntime,
  useWorkbenchProbeSession,
} from './WorkbenchProvider.test-support'

const DEFAULT_DEVICE_A = 'gateway-default-a'
const DEFAULT_WORKSPACE_A = '/gateway/default-a'
const PROJECT_B_ADDRESS: RuntimeTaskAddress = {
  deviceId: 'project-device-b',
  workspacePath: '/workspace/project-b',
  taskId: 'task-b',
}

function AttachmentTargetProbe({ file }: { file: File }) {
  const { workbench } = useWorkbenchProbeSession()
  const currentTask = workbench.state.currentRuntimeTask

  return (
    <div>
      <span data-testid="startup-ready">{workbench.isStartupReady ? 'ready' : 'loading'}</span>
      <span data-testid="standalone-target">
        {workbench.state.standaloneDeviceId ?? 'none'}|{workbench.state.standaloneWorkspacePath ?? 'none'}
      </span>
      <span data-testid="current-task">
        {currentTask
          ? `${currentTask.deviceId}|${currentTask.workspacePath ?? 'none'}|${currentTask.taskId}`
          : 'none'}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(DEFAULT_DEVICE_A, DEFAULT_WORKSPACE_A, 'Default A')
        }
      >
        open default A
      </button>
      <button type="button" onClick={() => void workbench.openRuntimeTask(PROJECT_B_ADDRESS)}>
        open task B
      </button>
      <button type="button" onClick={() => void workbench.projectChat.handleFileSelect(file)}>
        upload file
      </button>
    </div>
  )
}

describe('WorkbenchProvider attachment target', () => {
  let gatewayTokenMeta: HTMLMetaElement

  beforeEach(() => {
    clearGatewayRuntime()
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    gatewayTokenMeta = document.createElement('meta')
    gatewayTokenMeta.name = 'kcoder-rpc-token'
    gatewayTokenMeta.content = 'test-gateway-token'
    document.head.append(gatewayTokenMeta)
    setGatewayRuntime()
  })

  afterEach(() => {
    gatewayTokenMeta.remove()
    clearGatewayRuntime()
  })

  test('uploads to the selected project task rather than the Gateway standalone default', async () => {
    const user = userEvent.setup()
    const file = new File(['payload'], 'payload.txt', { type: 'text/plain' })
    const uploadAttachment = vi.fn().mockResolvedValue({
      id: 901,
      filename: file.name,
      file_size: file.size,
      mime_type: file.type,
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-11-13T00:00:00.000Z',
    })
    const projectB = createProject({
      id: 18,
      name: 'Project B',
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: PROJECT_B_ADDRESS.deviceId },
        workspace: { source: 'local_path', localPath: PROJECT_B_ADDRESS.workspacePath },
      },
    })
    const services = createWorkbenchServices({
      projectApi: { listProjects: vi.fn().mockResolvedValue({ items: [projectB] }) },
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            id: 1,
            device_id: DEFAULT_DEVICE_A,
            name: 'Gateway default A',
            is_default: true,
          }),
          createDevice({
            id: 2,
            device_id: PROJECT_B_ADDRESS.deviceId,
            name: 'Project device B',
            is_default: false,
          }),
        ]),
      },
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [
            {
              project: { key: 'project-18', id: projectB.id, name: projectB.name },
              deviceWorkspaces: [
                {
                  id: 82,
                  projectId: projectB.id,
                  deviceId: PROJECT_B_ADDRESS.deviceId,
                  deviceName: 'Project device B',
                  deviceStatus: 'online',
                  workspacePath: PROJECT_B_ADDRESS.workspacePath,
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: PROJECT_B_ADDRESS.taskId,
                      workspacePath: PROJECT_B_ADDRESS.workspacePath,
                      title: 'Task B',
                      runtime: 'claude_code',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          chats: [],
          totalTasks: 1,
        }),
        openRuntimeWorkspace: vi.fn().mockResolvedValue({
          accepted: true,
          deviceId: DEFAULT_DEVICE_A,
          workspacePath: DEFAULT_WORKSPACE_A,
          runtime: 'claude_code',
        }),
        getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
          taskId: address.taskId,
          workspacePath: address.workspacePath ?? PROJECT_B_ADDRESS.workspacePath,
          runtime: 'claude_code',
          messages: [],
        })),
      }),
      attachmentApi: { uploadAttachment, deleteAttachment: vi.fn().mockResolvedValue(undefined) },
    } as Partial<WorkbenchServices>)

    renderWorkbench(<AttachmentTargetProbe file={file} />, services)

    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    await user.click(screen.getByRole('button', { name: 'open default A' }))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-target')).toHaveTextContent(
        `${DEFAULT_DEVICE_A}|${DEFAULT_WORKSPACE_A}`
      )
    )

    await user.click(screen.getByRole('button', { name: 'open task B' }))
    await waitFor(() =>
      expect(screen.getByTestId('current-task')).toHaveTextContent(
        `${PROJECT_B_ADDRESS.deviceId}|${PROJECT_B_ADDRESS.workspacePath}|${PROJECT_B_ADDRESS.taskId}`
      )
    )

    await user.click(screen.getByRole('button', { name: 'upload file' }))
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1))

    const uploadCall = uploadAttachment.mock.calls[0]
    expect(uploadCall[0]).toBe(file)
    expect(uploadCall[3]).toEqual({
      deviceId: PROJECT_B_ADDRESS.deviceId,
      workspacePath: PROJECT_B_ADDRESS.workspacePath,
    })
  })
})
