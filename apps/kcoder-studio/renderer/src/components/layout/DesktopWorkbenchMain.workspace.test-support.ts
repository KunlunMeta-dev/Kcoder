import { render } from '@testing-library/react'
import { createElement } from 'react'
import { vi } from 'vitest'
import { AppearanceProvider } from '@/features/appearance'
import { DesktopWorkbenchLayout, baseProps } from './DesktopWorkbenchLayout.test-harness'

export function createRect({
  left,
  top,
  width,
  height,
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

export function mockDesktopWorkbenchMainWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (
      this.tagName === 'MAIN' &&
      this.querySelector('[data-testid="desktop-workbench-content"]')
    ) {
      return createRect({ left: 0, top: 0, width, height: 720 })
    }
    return createRect({ left: 0, top: 0, width: 0, height: 0 })
  })
}

export function getWorkspaceCodeViewText() {
  return Array.from(
    document.querySelectorAll('[data-testid="workspace-file-preview-code-view"] diffs-container')
  )
    .map(container => container.shadowRoot?.textContent ?? '')
    .join('\n')
}

export function getWorkspaceCodeViewSelectedLineNumbers() {
  return Array.from(
    document.querySelectorAll('[data-testid="workspace-file-preview-code-view"] diffs-container')
  ).flatMap(container =>
    Array.from(container.shadowRoot?.querySelectorAll('[data-line][data-selected-line]') ?? []).map(
      line => line.getAttribute('data-line')
    )
  )
}

export function createCloudWorkspacePanelState(capabilities?: string[]) {
  const workspaceDevice = {
    id: 11,
    device_id: 'workspace-cloud-device',
    name: 'Workspace Cloud Device',
    status: 'online' as const,
    is_default: false,
    device_type: 'cloud' as const,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...(capabilities ? { capabilities } : {}),
  }
  const workspaceProject = {
    id: 12,
    name: 'workspace-project',
    tasks: [],
    config: {
      mode: 'workspace' as const,
      execution: {
        targetType: 'cloud' as const,
        deviceId: workspaceDevice.device_id,
      },
      workspace: {
        source: 'git' as const,
        checkoutPath: '/workspace/project',
      },
    },
  }

  return {
    currentProject: workspaceProject,
    projects: [workspaceProject],
    devices: [workspaceDevice],
  }
}

export function createLocalSkillDevice() {
  return {
    id: 13,
    device_id: 'device-local-real',
    name: 'Local Mac',
    status: 'online' as const,
    is_default: true,
    device_type: 'local' as const,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  }
}

export function renderWorkspacePanelLayout({
  mainWidth,
  withAppearance = false,
  deviceCapabilities,
  standaloneChatKey,
}: {
  mainWidth?: number
  withAppearance?: boolean
  deviceCapabilities?: string[]
  standaloneChatKey?: number
} = {}) {
  if (mainWidth) {
    mockDesktopWorkbenchMainWidth(mainWidth)
  }

  const workspacePanelState = createCloudWorkspacePanelState(deviceCapabilities)
  const layout = createElement(DesktopWorkbenchLayout, {
    ...baseProps,
    state: {
      ...baseProps.state,
      ...workspacePanelState,
      ...(standaloneChatKey == null ? {} : { standaloneChatKey }),
    },
    projectWork: {
      ...baseProps.projectWork,
      projects: workspacePanelState.projects,
      devices: workspacePanelState.devices,
      currentProjectId: workspacePanelState.currentProject.id,
    },
  })
  return render(withAppearance ? createElement(AppearanceProvider, null, layout) : layout)
}

export function createLocalRuntimeTaskPanelFixture() {
  const runtimeProject = {
    id: 35,
    name: 'Wegent',
    tasks: [],
  }
  const localDevice = {
    id: 43,
    device_id: 'local-device',
    name: 'Mac',
    status: 'online' as const,
    is_default: false,
    device_type: 'local' as const,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  }
  const taskSuffixes = 'abcdefghijk'.split('')
  const taskAddresses = taskSuffixes.map(suffix => ({
    deviceId: localDevice.device_id,
    workspacePath: `/Users/me/Wegent/.worktrees/${suffix}`,
    taskId: `runtime-${suffix}`,
  }))
  const runtimeWork = {
    projects: [
      {
        project: {
          id: runtimeProject.id,
          key: 'project:wegent',
          name: runtimeProject.name,
        },
        deviceWorkspaces: [
          {
            id: 44,
            deviceId: localDevice.device_id,
            deviceStatus: 'online' as const,
            available: true,
            workspacePath: '/Users/me/Wegent',
            workspaceSource: 'local' as const,
            tasks: taskSuffixes.map(suffix => ({
              taskId: `runtime-${suffix}`,
              workspacePath: `/Users/me/Wegent/.worktrees/${suffix}`,
              title: `Task ${suffix.toUpperCase()}`,
              runtime: 'codex',
            })),
          },
        ],
      },
    ],
    chats: [],
    totalTasks: taskSuffixes.length,
  }
  const [taskA, taskB, taskC] = taskAddresses
  const propsForTask = (
    task: (typeof taskAddresses)[number],
    options: { runtimeWork?: typeof runtimeWork } = {}
  ) => ({
    ...baseProps,
    state: {
      ...baseProps.state,
      currentProject: runtimeProject,
      currentRuntimeTask: task,
      projects: [runtimeProject],
      devices: [localDevice],
      runtimeWork: options.runtimeWork ?? runtimeWork,
    },
    projectWork: {
      ...baseProps.projectWork,
      projects: [runtimeProject],
      devices: [localDevice],
      runtimeWork: options.runtimeWork ?? runtimeWork,
      currentProject: runtimeProject,
      currentProjectId: runtimeProject.id,
      selectedDeviceWorkspaceId: 44,
      executionMode: 'current_workspace' as const,
    },
  })

  return {
    localDevice,
    propsForTask,
    runtimeWork,
    runtimeProject,
    taskA,
    taskB,
    taskC,
    taskAddresses,
  }
}
