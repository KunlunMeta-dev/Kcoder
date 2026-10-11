import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import '@/i18n'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CloudWorkStatus } from '@/types/workbench'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { DesktopSidebar } from '../DesktopSidebar'
export function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-device',
    name: 'Local Mac',
    status: 'online',
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

export function cloudWorkStatus(
  overrides: Partial<CloudWorkStatus> & { checks?: Partial<CloudWorkStatus['checks']> } = {}
): CloudWorkStatus {
  const defaultStatus: CloudWorkStatus = {
    availability: 'available',
    checks: {
      teams: 'available',
      devices: 'available',
      runtimeWork: 'available',
    },
    error: null,
    updatedAt: '2026-06-26T00:00:00.000Z',
  }
  return {
    ...defaultStatus,
    ...overrides,
    checks: {
      ...defaultStatus.checks,
      ...overrides.checks,
    },
  }
}

export function project(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 7,
    name: 'Wegent',
    tasks: [],
    ...overrides,
  }
}

export function createSidebarProps(overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {}) {
  return {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [project()],
    devices: [localDevice()],
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onOpenSearch: vi.fn(),
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onOpenSettings: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  }
}

export function renderSidebar(
  overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {},
  cloudConnection?: Partial<CloudConnectionContextValue>,
  appUpdate?: Partial<AppUpdateContextValue>
) {
  const props: Parameters<typeof DesktopSidebar>[0] = createSidebarProps(overrides)
  const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-test')
  lifecycleStore.syncRuntimeWork(props.runtimeWork)

  let tree = (
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <DesktopSidebar {...props} />
    </RuntimeTaskLifecycleProvider>
  )
  if (appUpdate) {
    const value: AppUpdateContextValue = {
      availableUpdate: null,
      status: 'idle',
      downloadProgress: null,
      message: null,
      error: null,
      checkNow: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      ...appUpdate,
    }
    tree = <AppUpdateContext.Provider value={value}>{tree}</AppUpdateContext.Provider>
  }
  if (cloudConnection) {
    const value: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'test-disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
      ...cloudConnection,
    }
    return render(
      <CloudConnectionContext.Provider value={value}>{tree}</CloudConnectionContext.Provider>
    )
  }
  return render(tree)
}

export function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}
