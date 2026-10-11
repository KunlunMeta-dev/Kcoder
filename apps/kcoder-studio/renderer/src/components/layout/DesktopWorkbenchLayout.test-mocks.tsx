import { useEffect } from 'react'
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { createProjectApi } from '@/api/projects'
import { openExternalUrl } from '@/lib/external-links'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  getLocalPathKind,
  isLocalTerminalAvailable,
  localPathExists,
  openLocalWorkspace,
  startLocalTerminal,
} from '@/lib/local-terminal'

const originalRtlSkipAutoCleanup = process.env.RTL_SKIP_AUTO_CLEANUP
process.env.RTL_SKIP_AUTO_CLEANUP = 'true'
const originalQueueMicrotask = globalThis.queueMicrotask.bind(globalThis)
const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window)

const paneSessionMockRef = vi.hoisted(() => ({
  current: undefined as unknown,
}))
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const cloudDesktopExtensionMock = vi.hoisted(() => {
  const launch = vi.fn()

  return {
    available: false,
    DeviceAction: () => null,
    WorkspaceAction: ({
      onLaunchActionChange,
    }: {
      onLaunchActionChange?: (
        action: ((options?: { notifyOpened?: boolean }) => Promise<void>) | null
      ) => void
    }) => {
      useEffect(() => {
        const launchAction = async (options?: { notifyOpened?: boolean }) => {
          await launch(options)
        }
        onLaunchActionChange?.(launchAction)
        return () => onLaunchActionChange?.(null)
      }, [onLaunchActionChange])
      return null
    },
    isInternalPageUrl: vi.fn(() => false),
    launch,
  }
})

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
}))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('./useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => paneSessionMockRef.current,
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const nativeDirectoryPickerMocks = vi.hoisted(() => ({
  openNativeProjectDirectoryPicker: vi.fn(),
}))

const automationMocks = vi.hoisted(() => ({
  useNativeDirectoryPicker: true,
}))

vi.mock('@/e2e/automation', () => ({
  shouldUseNativeProjectDirectoryPicker: () => automationMocks.useNativeDirectoryPicker,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPicker: nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker,
  openNativeProjectDirectoryPickers: async (...args: unknown[]) => {
    const selected = await nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker(...args)
    return selected ? [selected] : []
  },
}))

const tauriMenuMocks = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
  menuNew: vi.fn(),
  menuPopup: vi.fn(),
}))

const authMocks = vi.hoisted(() => ({
  logout: vi.fn(),
}))

const tauriEventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}))

export const openExternalUrlMock = vi.mocked(openExternalUrl)

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ appBasePath: '', apiBaseUrl: '/api' }),
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/api/local/codexUsage', () => ({
  emptyCodexUsageDisplay: () => ({
    status: 'none',
    fiveHour: { label: '5h', title: '5小时额度', value: '无', percent: null, resetsAt: null },
    sevenDay: { label: '7d', title: '7天额度', value: '无', percent: null, resetsAt: null },
    trayTitle: '5h --\n7d --',
    tooltip: '5小时额度 无\n7天额度 无',
  }),
  getLocalCodexUsageDisplay: vi.fn(),
  formatCodexUsageResetTime: vi.fn(() => null),
}))

vi.mock('@/features/auth/useAuth', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/auth/useAuth')>()),
  useAuth: () => ({
    logout: authMocks.logout,
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  closeLocalTerminal: vi.fn(),
  getLocalPathKind: vi.fn(),
  getLocalExecutorDeviceId: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
  localPathExists: vi.fn(),
  openLocalWorkspace: vi.fn(),
  startLocalTerminal: vi.fn(),
}))

vi.mock('@pierre/diffs/react', async () => {
  const actual = await vi.importActual<typeof import('@pierre/diffs/react')>('@pierre/diffs/react')

  return {
    ...actual,
    PatchDiff: ({ patch }: { patch: string }) => <pre data-testid="pierre-patch-diff">{patch}</pre>,
  }
})

vi.mock('@pierre/trees/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  interface MockTreeModel {
    paths: string[]
    search: string | null
    selectedPaths: string[]
    onSelectionChange?: (paths: string[]) => void
    getItem: (path: string) => {
      expand: () => void
      select: () => void
    }
    scrollToPath: () => void
    selectPath: (path: string) => void
    setSearch: (query: string | null) => void
  }

  function selectModelPath(model: MockTreeModel, path: string) {
    if (model.selectedPaths[0] === path) return

    model.selectedPaths = [path]
    model.onSelectionChange?.([path])
  }

  return {
    FileTree: ({ model, ...props }: { model: MockTreeModel; [key: string]: unknown }) => {
      const visiblePaths = model.search
        ? model.paths.filter(path => path.toLowerCase().includes(model.search!.toLowerCase()))
        : model.paths

      return (
        <div {...props}>
          {visiblePaths.map(path => {
            const isDirectory = path.endsWith('/')
            const label = path.replace(/\/+$/, '').split('/').pop() || path
            const depth = path.replace(/\/+$/, '').split('/').length - 1
            const selected = model.selectedPaths.includes(path)
            const testId = isDirectory ? 'workspace-directory-row' : 'workspace-file-row'

            return (
              <button
                key={path}
                type="button"
                data-testid={testId}
                data-depth={depth.toString()}
                aria-expanded={isDirectory ? 'true' : undefined}
                className={selected ? 'ring-1 ring-primary' : undefined}
                onClick={() => model.selectPath(path)}
              >
                {Array.from({ length: depth }, (_, index) => (
                  <span key={index} data-testid="workspace-tree-indent-guide" />
                ))}
                {label}
              </button>
            )
          })}
        </div>
      )
    },
    useFileTree: ({
      initialSelectedPaths,
      onSelectionChange,
      paths,
    }: {
      initialSelectedPaths?: string[]
      onSelectionChange?: (paths: string[]) => void
      paths: string[]
    }) => {
      const modelRef = React.useRef<MockTreeModel | null>(null)

      if (!modelRef.current) {
        modelRef.current = {
          paths,
          search: null,
          selectedPaths: initialSelectedPaths ?? [],
          onSelectionChange,
          getItem: (path: string) => ({
            expand: vi.fn(),
            select: () => selectModelPath(modelRef.current!, path),
          }),
          scrollToPath: vi.fn(),
          selectPath: (path: string) => selectModelPath(modelRef.current!, path),
          setSearch(query: string | null) {
            this.search = query
          },
        }
      }

      modelRef.current.paths = paths
      modelRef.current.onSelectionChange = onSelectionChange
      modelRef.current.selectedPaths = initialSelectedPaths ?? modelRef.current.selectedPaths

      return { model: modelRef.current }
    },
  }
})

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    x: number
    y: number

    constructor(x: number, y: number) {
      this.x = x
      this.y = y
    }
  },
}))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: tauriMenuMocks.menuNew,
  },
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: tauriMenuMocks.getCurrentWindow,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriEventMocks.listen,
}))

vi.mock('@/components/chat/MessageTurnNavigation', () => ({
  MessageTurnNavigation: () => null,
}))

vi.mock('./workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: ({
    active,
    sessionId,
    testIdsEnabled = true,
  }: {
    active: boolean
    sessionId: string
    testIdsEnabled?: boolean
  }) => (
    <div
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      data-session-id={sessionId}
      className="h-full w-full"
      hidden={!active}
    />
  ),
}))

vi.mock('./workspace-panels/EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: ({
    active,
    sessionId,
    testIdsEnabled = true,
  }: {
    active: boolean
    sessionId: string
    testIdsEnabled?: boolean
  }) => (
    <div
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      data-session-id={sessionId}
      hidden={!active}
    />
  ),
}))

export const createDeviceApiMock = vi.mocked(createDeviceApi)
export const createProjectApiMock = vi.mocked(createProjectApi)
export const getLocalCodexUsageDisplayMock = vi.mocked(getLocalCodexUsageDisplay)
export const closeLocalTerminalMock = vi.mocked(closeLocalTerminal)
export const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
export const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
export const localPathExistsMock = vi.mocked(localPathExists)
export const getLocalPathKindMock = vi.mocked(getLocalPathKind)
export const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
export const startLocalTerminalMock = vi.mocked(startLocalTerminal)
export const startTerminalSessionMock = vi.fn()
export const startCodeServerSessionMock = vi.fn()
export const startDeviceTerminalSessionMock = vi.fn()
export const startDeviceCodeServerSessionMock = vi.fn()
export const createRemoteTerminalClientMock = vi.fn()
export const createTemporaryRuntimeTaskMock = vi.fn()
export const subscribeRuntimeTaskStreamMock = vi.fn(() => vi.fn())

vi.mock('@/components/chat/composer/TaskPlanProgress', () => ({ TaskPlanProgress: () => null }))

export function getDesktopWorkbenchHoistedMocks() {
  return {
    paneSessionMockRef,
    experimentalFeatures,
    cloudDesktopExtensionMock,
    nativeDirectoryPickerMocks,
    automationMocks,
    tauriMenuMocks,
    authMocks,
  }
}

export function expectAndClearConsoleError(...expected: unknown[]) {
  expect(consoleErrorSpy).toHaveBeenCalledWith(...expected)
  consoleErrorSpy?.mockClear()
}

export function expectAndClearConsoleWarn(expectedMessage: string, expectedCount: number) {
  expect(consoleWarnSpy).toHaveBeenCalledTimes(expectedCount)
  for (const [message] of consoleWarnSpy?.mock.calls ?? []) expect(message).toBe(expectedMessage)
  consoleWarnSpy?.mockClear()
}

const originalCanvasGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext'
)
const originalCanvasGetContext = HTMLCanvasElement.prototype.getContext
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  ...originalCanvasGetContextDescriptor,
  configurable: true,
  value: function getContext(
    this: HTMLCanvasElement,
    contextId: Parameters<HTMLCanvasElement['getContext']>[0],
    ...args: unknown[]
  ) {
    if (contextId === '2d') return null
    return originalCanvasGetContext.call(this, contextId, ...args)
  },
})

type GlobalSnapshot = { target: object; key: PropertyKey; descriptor?: PropertyDescriptor }
let globalSnapshots: GlobalSnapshot[] = []
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null
let rtlAct: (typeof import('@testing-library/react'))['act']
function snapshotGlobal(target: object, key: PropertyKey): GlobalSnapshot {
  return { target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }
}
function restoreGlobal({ target, key, descriptor }: GlobalSnapshot) {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

beforeEach(async () => {
  rtlAct = (await import('@testing-library/react')).act
  globalSnapshots = [
    snapshotGlobal(globalThis, 'isTauri'),
    snapshotGlobal(window, '__TAURI__'),
    snapshotGlobal(window, '__TAURI_INTERNALS__'),
    snapshotGlobal(window, 'innerWidth'),
    snapshotGlobal(window, 'innerHeight'),
    snapshotGlobal(globalThis, 'queueMicrotask'),
    snapshotGlobal(window, 'requestAnimationFrame'),
    snapshotGlobal(window, 'cancelAnimationFrame'),
    snapshotGlobal(navigator, 'clipboard'),
    snapshotGlobal(Element.prototype, 'scrollIntoView'),
    snapshotGlobal(Element.prototype, 'scrollTo'),
    snapshotGlobal(HTMLCanvasElement.prototype, 'getContext'),
  ]
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  Object.defineProperty(globalThis, 'queueMicrotask', {
    configurable: true,
    value: (callback: VoidFunction) =>
      originalQueueMicrotask(() => {
        rtlAct(callback)
      }),
  })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      originalRequestAnimationFrame(time => {
        rtlAct(() => callback(time))
      }),
  })
  paneSessionMockRef.current = undefined
  experimentalFeatures.enabled = true
  cloudDesktopExtensionMock.available = false
  cloudDesktopExtensionMock.isInternalPageUrl.mockReturnValue(false)
  cloudDesktopExtensionMock.launch.mockResolvedValue(true)
  tauriEventMocks.listen.mockResolvedValue(vi.fn())
  delete (globalThis as typeof globalThis & { isTauri?: unknown }).isTauri
  delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

afterAll(() => {
  if (originalRtlSkipAutoCleanup === undefined) delete process.env.RTL_SKIP_AUTO_CLEANUP
  else process.env.RTL_SKIP_AUTO_CLEANUP = originalRtlSkipAutoCleanup
  if (originalCanvasGetContextDescriptor) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      'getContext',
      originalCanvasGetContextDescriptor
    )
  }
})

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  await Promise.resolve()
  await Promise.resolve()
  const errors =
    consoleErrorSpy?.mock.calls.map((args: unknown[]) => args.map(String).join(' ')) ?? []
  const warnings =
    consoleWarnSpy?.mock.calls.map((args: unknown[]) => args.map(String).join(' ')) ?? []
  for (const snapshot of [...globalSnapshots].reverse()) restoreGlobal(snapshot)
  globalSnapshots = []
  vi.restoreAllMocks()
  expect(
    errors,
    `DesktopWorkbenchLayout tests must not emit console.error or React act warnings: ${JSON.stringify(errors)}`
  ).toEqual([])
  expect(
    warnings,
    `DesktopWorkbenchLayout tests must not emit console.warn: ${JSON.stringify(warnings)}`
  ).toEqual([])
})
