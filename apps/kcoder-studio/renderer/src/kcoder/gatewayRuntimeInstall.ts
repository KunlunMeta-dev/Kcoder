import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { gatewayVerificationConfig } from '@/e2e/gateway-verification'
import { copyTextToClipboard } from '@/lib/clipboard'
import { gatewayToken } from './gatewayRpc'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import {
  readGatewayCodexLocalConfig,
  readPreferences,
  updateGatewayCodexLocalConfig,
  writePreferences,
} from './gatewayRuntimeSettings'
import {
  registerGatewayWorkspaceSessionRuntime,
  registerGatewayCommandTransport,
  type GatewayWorkspaceSessionRuntime,
} from './gatewayServiceBridge'

type GatewayIpcHandler = (command: string, payload?: unknown) => Promise<unknown> | unknown
type GatewayInstallCleanup = () => void

export interface GatewayRuntimeInstallDependencies {
  readToken: () => string | null
  createRuntime: (token: string) => KCoderGatewayRuntime
  installIpc: (handler: GatewayIpcHandler) => GatewayInstallCleanup
  registerWorkspaceRuntime: (runtime: GatewayWorkspaceSessionRuntime) => () => void
  addBeforeUnload: (listener: () => void) => void
  removeBeforeUnload: (listener: () => void) => void
}

export interface GatewayRuntimeInstallation {
  runtime: KCoderGatewayRuntime
  cleanup: () => void
}

export interface GatewayRuntimeLifecycleDependencies<
  Runtime extends GatewayWorkspaceSessionRuntime & { dispose(): void },
> {
  readToken: () => string | null
  createRuntime: (token: string) => Runtime
  createIpcHandler: (runtime: Runtime) => GatewayIpcHandler
  installIpc: (handler: GatewayIpcHandler) => GatewayInstallCleanup
  installNavigation?: () => GatewayInstallCleanup
  registerWorkspaceRuntime: (runtime: GatewayWorkspaceSessionRuntime) => () => void
  addBeforeUnload: (listener: () => void) => void
  removeBeforeUnload: (listener: () => void) => void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function createGatewayIpcHandler(runtime: KCoderGatewayRuntime): GatewayIpcHandler {
  return async (command, payload) => {
    const args = record(payload)
    if (command === 'local_executor_copy_debug_info') {
      if (typeof args.text !== 'string' || args.text.length > 1024 * 1024)
        throw new Error('Invalid clipboard text')
      return copyTextToClipboard(args.text)
    }
    if (command === 'get_app_preferences') return readPreferences()
    if (command === 'update_app_preferences') return writePreferences(args.patch)
    if (
      command === 'local_executor_ensure_started' ||
      command === 'local_executor_status' ||
      command === 'local_executor_connect_backend' ||
      command === 'local_executor_disconnect_backend'
    ) {
      return runtime.status()
    }
    if (command === 'local_executor_request') {
      return runtime.request(text(args.method) ?? '', args.params, { signal: args.signal instanceof AbortSignal ? args.signal : undefined })
    }
    if (command === 'local_executor_read_codex_local_config') {
      return readGatewayCodexLocalConfig()
    }
    if (command === 'local_executor_update_codex_local_config') {
      return updateGatewayCodexLocalConfig(args.patch)
    }
    if (command === 'save_local_attachment_file') return runtime.saveAttachmentForIpc(args)
    if (command === 'start_local_attachment_upload') return runtime.startAttachmentUpload(args)
    if (command === 'append_local_attachment_upload') return runtime.appendAttachmentUpload(args)
    if (command === 'finish_local_attachment_upload') return runtime.finishAttachmentUpload(args)
    if (command === 'cancel_local_attachment_upload') return runtime.cancelAttachmentUpload(args)
    if (command === 'read_local_attachment_file') return runtime.readAttachment(args)
    if (command === 'embedded_browser_open') return runtime.openBrowser(args)
    if (command === 'embedded_browser_set_bounds') return runtime.setBrowserBounds(args)
    if (command === 'embedded_browser_navigate') {
      return runtime.controlBrowser(args.label, { action: 'navigate', url: text(args.url) })
    }
    if (command === 'embedded_browser_reload') {
      return runtime.controlBrowser(args.label, { action: 'reload' })
    }
    if (command === 'embedded_browser_go_back') {
      return runtime.controlBrowser(args.label, { action: 'back' })
    }
    if (command === 'embedded_browser_go_forward') {
      return runtime.controlBrowser(args.label, { action: 'forward' })
    }
    if (command === 'embedded_browser_eval') {
      await runtime.evaluateBrowser(args)
      return null
    }
    if (command === 'embedded_browser_eval_json') return runtime.evaluateBrowser(args)
    if (command === 'embedded_browser_page_state') return runtime.readBrowserPageState(args.label)
    if (command === 'embedded_browser_relabel') {
      return runtime.relabelBrowser(args.fromLabel, args.toLabel)
    }
    if (command === 'embedded_browser_close') return runtime.closeBrowser(args.label)
    if (command === 'embedded_browser_clear_data') return runtime.clearBrowserData()
    if (
      command === 'embedded_browser_pause_download' ||
      command === 'embedded_browser_resume_download' ||
      command === 'embedded_browser_delete_download'
    ) {
      throw new Error('KCoder 远程浏览器暂不支持下载管理')
    }
    if (command === 'local_executor_read_log') {
      const status = await runtime.status()
      return {
        path: '',
        content: 'KCoder browser gateway transport',
        truncated: false,
        lineCount: 1,
        transport: 'stdio',
        transportConnected: true,
        processPids: [],
        processPaths: [],
        sidecarSource: 'browser-gateway',
        sidecarPath: '',
        currentDir: '',
        executorHome: '',
        backendUrl: null,
        hasBackendAuthToken: false,
        pendingRequestCount: 0,
        status,
      }
    }
    if (command === 'take_pending_system_drag_drops') return []
    if (command === 'get_appshots_status') {
      return {
        supported: false,
        shortcut: 'CommandOrControl+Shift+2',
        shortcutRegistered: false,
        screenCapturePermissionGranted: false,
        accessibilityPermissionGranted: false,
      }
    }
    if (
      command === 'take_pending_local_workspace_open_requests' ||
      command === 'take_pending_appshots'
    ) {
      return []
    }
    if (command === 'get_process_diagnostics_snapshot') return { processes: [] }
    if (
      command === 'register_frontend_recovery_bridge' ||
      command === 'acknowledge_frontend_resume_probe' ||
      command === 'log_system_drag_debug' ||
      command === 'set_tray_menu_state' ||
      command === 'open_appshots_permission_settings' ||
      command === 'acknowledge_appshot' ||
      command === 'plugin:log|log'
    ) {
      return null
    }
    if (command.startsWith('plugin:window|')) return null
    throw new Error(`KCoder browser mode does not support native command: ${command}`)
  }
}

interface GatewayIpcInstallationLayer {
  active: boolean
  installedInvoke: unknown
  restore: () => void
}

const ipcLayerByInvoke = new Map<unknown, GatewayIpcInstallationLayer>()

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: Record<string, unknown>
  __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
  __KCODER_GATEWAY_WEB_SHIM__?: boolean
}

interface WindowObjectSnapshot {
  key: '__TAURI_INTERNALS__' | '__TAURI_EVENT_PLUGIN_INTERNALS__' | '__KCODER_GATEWAY_WEB_SHIM__'
  present: boolean
  descriptor: PropertyDescriptor | undefined
  value: unknown
  objectDescriptors: PropertyDescriptorMap | null
}

function snapshotWindowObject(target: TauriWindow, key: WindowObjectSnapshot['key']) {
  const present = Object.prototype.hasOwnProperty.call(target, key)
  const value = target[key]
  return {
    key,
    present,
    descriptor: present ? Object.getOwnPropertyDescriptor(target, key) : undefined,
    value,
    objectDescriptors:
      value && typeof value === 'object' ? Object.getOwnPropertyDescriptors(value) : null,
  } satisfies WindowObjectSnapshot
}

function restoreWindowObject(target: TauriWindow, snapshot: WindowObjectSnapshot) {
  if (snapshot.value && typeof snapshot.value === 'object' && snapshot.objectDescriptors) {
    for (const key of Reflect.ownKeys(snapshot.value)) {
      if (!(key in snapshot.objectDescriptors))
        delete (snapshot.value as Record<PropertyKey, unknown>)[key]
    }
    Object.defineProperties(snapshot.value, snapshot.objectDescriptors)
  }
  if (!snapshot.present) {
    delete target[snapshot.key]
    return
  }
  if (snapshot.descriptor) Object.defineProperty(target, snapshot.key, snapshot.descriptor)
}

function restoreWindowObjects(target: TauriWindow, snapshots: WindowObjectSnapshot[]) {
  let restoreError: unknown
  for (const snapshot of snapshots) {
    try {
      restoreWindowObject(target, snapshot)
    } catch (error) {
      restoreError ??= error
    }
  }
  if (restoreError) throw restoreError
}

export function installGatewayIpc(handler: GatewayIpcHandler): GatewayInstallCleanup {
  if (gatewayVerificationConfig()) {
    if (!gatewayToken()) throw new Error('Gateway verification requires a Gateway token')
    return registerGatewayCommandTransport(handler)
  }
  const tauriWindow = window as TauriWindow
  const snapshots = [
    snapshotWindowObject(tauriWindow, '__TAURI_INTERNALS__'),
    snapshotWindowObject(tauriWindow, '__TAURI_EVENT_PLUGIN_INTERNALS__'),
    snapshotWindowObject(tauriWindow, '__KCODER_GATEWAY_WEB_SHIM__'),
  ]
  try {
    if (!isTauriRuntime()) tauriWindow.__KCODER_GATEWAY_WEB_SHIM__ = true
    mockWindows('main')
    mockIPC(handler, { shouldMockEvents: true })
  } catch (error) {
    try {
      restoreWindowObjects(tauriWindow, snapshots)
    } catch {
      // The installation error is the root cause callers must handle; rollback errors cannot replace it.
    }
    throw error
  }
  const installedInvoke = tauriWindow.__TAURI_INTERNALS__?.invoke
  const layer: GatewayIpcInstallationLayer = {
    active: true,
    installedInvoke,
    restore: () => {
      const internals = tauriWindow.__TAURI_INTERNALS__
      if (!internals || internals.invoke !== installedInvoke) return
      restoreWindowObjects(tauriWindow, snapshots)
      ipcLayerByInvoke.delete(installedInvoke)
      const previousLayer = ipcLayerByInvoke.get(tauriWindow.__TAURI_INTERNALS__?.invoke)
      if (previousLayer && !previousLayer.active) previousLayer.restore()
    },
  }
  ipcLayerByInvoke.set(installedInvoke, layer)
  return () => {
    if (!layer.active) return
    layer.active = false
    // When superseded by a new installation, mark this layer stale only; continue skipping it after the new layer is removed.
    layer.restore()
  }
}

const defaultDependencies: GatewayRuntimeInstallDependencies = {
  readToken: () => (typeof document === 'undefined' ? null : gatewayToken()),
  createRuntime: token => new KCoderGatewayRuntime(token),
  installIpc: installGatewayIpc,
  registerWorkspaceRuntime: registerGatewayWorkspaceSessionRuntime,
  addBeforeUnload: listener => addEventListener('beforeunload', listener, { once: true }),
  removeBeforeUnload: listener => removeEventListener('beforeunload', listener),
}

export function installGatewayRuntime(
  dependencies: GatewayRuntimeInstallDependencies = defaultDependencies
): GatewayRuntimeInstallation | null {
  return installGatewayRuntimeLifecycle({
    ...dependencies,
    createIpcHandler: createGatewayIpcHandler,
  })
}

export function installGatewayRuntimeLifecycle<
  Runtime extends GatewayWorkspaceSessionRuntime & { dispose(): void },
>(
  dependencies: GatewayRuntimeLifecycleDependencies<Runtime>
): { runtime: Runtime; cleanup: () => void } | null {
  const token = dependencies.readToken()
  if (!token) return null

  const runtime = dependencies.createRuntime(token)
  let uninstallIpc: GatewayInstallCleanup | null = null
  let unregisterWorkspaceRuntime: (() => void) | null = null
  let uninstallNavigation: (() => void) | null = null
  let unloadRegistered = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    let cleanupError: unknown
    const runCleanup = (operation: (() => void) | null) => {
      if (!operation) return
      try {
        operation()
      } catch (error) {
        cleanupError ??= error
      }
    }
    // Revoke published surfaces in reverse installation order, then release the runtime itself.
    if (unloadRegistered) runCleanup(() => dependencies.removeBeforeUnload(cleanup))
    runCleanup(unregisterWorkspaceRuntime)
    runCleanup(uninstallNavigation)
    runCleanup(uninstallIpc)
    runCleanup(() => runtime.dispose())
    if (cleanupError) throw cleanupError
  }

  try {
    uninstallIpc = dependencies.installIpc(dependencies.createIpcHandler(runtime))
    uninstallNavigation = dependencies.installNavigation?.() ?? null
    unregisterWorkspaceRuntime = dependencies.registerWorkspaceRuntime(runtime)
    unloadRegistered = true
    dependencies.addBeforeUnload(cleanup)
    return { runtime, cleanup }
  } catch (error) {
    try {
      cleanup()
    } catch {
      // Preserve the original installation error after cleanup attempts every inverse operation.
    }
    throw error
  }
}
