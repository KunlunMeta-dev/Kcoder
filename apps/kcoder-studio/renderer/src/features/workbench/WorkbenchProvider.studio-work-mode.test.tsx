import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { useWorkbench } from './useWorkbench'
import {
  createRuntimeWork,
  createDevice,
  createRuntimeWorkApiMock,
  createWorkbenchServices,
  renderWorkbench,
} from './WorkbenchProvider.test-support'
import type { RuntimeTaskAddress } from '@/types/api'
import { StudioWorkModeSwitcher } from '@/components/layout/StudioWorkModeSwitcher'

function Probe({
  address = {
    deviceId: 'device-1',
    taskId: 'runtime-a',
    workspacePath: '/workspace/project-alpha',
    runtimeHandle: { studioWorkMode: 'kcoder' },
  },
}: {
  address?: RuntimeTaskAddress
}) {
  const workbench = useWorkbench()
  return (
    <>
      <span data-testid="startup">{String(workbench.isStartupReady)}</span>
      <span data-testid="active-task">{workbench.state.currentRuntimeTask?.taskId ?? 'blank'}</span>
      <span data-testid="project">{workbench.state.currentProject?.id}</span>
      <span data-testid="standalone-device">{workbench.state.standaloneDeviceId}</span>
      <span data-testid="standalone-path">{workbench.state.standaloneWorkspacePath}</span>
      <span data-testid="workspace">{workbench.state.selectedDeviceWorkspaceId}</span>
      <input
        aria-label="Draft"
        value={workbench.projectChat.input}
        onChange={event => workbench.projectChat.setInput(event.target.value)}
      />
      <button
        onClick={() => {
          void workbench.openRuntimeTask(address)
        }}
      >
        Open existing
      </button>
      <StudioWorkModeSwitcher
        address={workbench.state.currentRuntimeTask}
        onNewChat={workbench.startNewChat}
      />
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
})

test('switching a running conversation restores the blank draft and preserves project/workspace without canceling', async () => {
  const runtimeWork = createRuntimeWork()
  runtimeWork.projects[0].deviceWorkspaces[0].tasks[0].running = true
  const api = createRuntimeWorkApiMock({ listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork) })
  const services = createWorkbenchServices({ runtimeWorkApi: api })
  renderWorkbench(<Probe />, services)
  await waitFor(() => expect(screen.getByTestId('startup')).toHaveTextContent('true'))
  await userEvent.type(screen.getByRole('textbox', { name: 'Draft' }), '保留空白任务草稿')
  await userEvent.click(screen.getByRole('button', { name: 'Open existing' }))
  await waitFor(() => expect(screen.getByTestId('active-task')).toHaveTextContent('runtime-a'))
  const project = screen.getByTestId('project').textContent
  await userEvent.click(screen.getByRole('button', { name: 'KWorker' }))
  expect(screen.getByTestId('active-task')).toHaveTextContent('blank')
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('保留空白任务草稿')
  expect(screen.getByTestId('project').textContent).toBe(project)
  expect(screen.getByTestId('workspace')).toHaveTextContent('22')
  expect(api.cancelRuntimeTask).not.toHaveBeenCalled()
  expect(runtimeWork.projects[0].deviceWorkspaces[0].tasks[0].running).toBe(true)
})

test('switching a remote standalone task keeps its actual target instead of the previous blank default', async () => {
  const address = {
    deviceId: 'remote-device',
    taskId: 'remote-task',
    workspacePath: '/home/office',
  }
  const runtimeWork = createRuntimeWork({
    projects: [],
    chats: [
      {
        id: 88,
        deviceId: 'remote-device',
        deviceName: 'Remote',
        deviceStatus: 'online',
        workspacePath: '/home/office',
        available: true,
        mapped: true,
        tasks: [
          {
            taskId: 'remote-task',
            title: 'Office',
            workspacePath: '/home/office',
            runtime: 'kcoder',
            running: true,
          },
        ],
      },
    ],
    totalTasks: 1,
  })
  const api = createRuntimeWorkApiMock({ listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork) })
  const base = createWorkbenchServices({ runtimeWorkApi: api })
  const services = {
    ...base,
    deviceApi: {
      ...base.deviceApi,
      listDevices: vi
        .fn()
        .mockResolvedValue([
          createDevice(),
          createDevice({ id: 56, device_id: 'remote-device', name: 'Remote' }),
        ]),
    },
  }
  renderWorkbench(<Probe address={address} />, services)
  await waitFor(() => expect(screen.getByTestId('startup')).toHaveTextContent('true'))
  expect(screen.getByTestId('standalone-device')).not.toHaveTextContent('remote-device')
  await userEvent.click(screen.getByRole('button', { name: 'Open existing' }))
  await waitFor(() => expect(screen.getByTestId('active-task')).toHaveTextContent('remote-task'))
  await userEvent.click(screen.getByRole('button', { name: 'KWorker' }))
  expect(screen.getByTestId('active-task')).toHaveTextContent('blank')
  expect(screen.getByTestId('standalone-device')).toHaveTextContent('remote-device')
  expect(screen.getByTestId('standalone-path')).toHaveTextContent('/home/office')
  expect(api.cancelRuntimeTask).not.toHaveBeenCalled()
})
