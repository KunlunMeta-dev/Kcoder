import { copyTextToClipboard } from '@/lib/clipboard'
import { desktopHost, syncDesktopPreferences, syncDesktopTrayState } from '../../desktopHost'
import type { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { LEGACY_KCODER_STUDIO_TAURI_COMMANDS } from '../../legacyRuntimeAbi'
import { record, text } from '../runtime/contracts'
import {
  readGatewayRuntimeConfig,
  readPreferences,
  updateGatewayRuntimeConfig,
  writePreferences,
} from './preferences'

export function createGatewayPageIpcHandler(runtime: KCoderGatewayRuntime) {
  return async (command: string, payload?: unknown) => {
    const args = record(payload)
    if (command === 'local_executor_copy_debug_info') {
      if (typeof args.text !== 'string' || args.text.length > 1024 * 1024)
        throw new Error('Invalid clipboard text')
      return copyTextToClipboard(args.text)
    }
    if (command === 'get_app_preferences') return syncDesktopPreferences(readPreferences())
    if (command === 'update_app_preferences') {
      return syncDesktopPreferences(writePreferences(args.patch))
    }
    if (command === 'set_tray_menu_state') return syncDesktopTrayState(record(args.state))
    if (command === 'close_main_window_to_tray') {
      const host = desktopHost()
      if (!host) throw new Error('System tray is only available in the desktop application')
      return host.hideToTray()
    }
    if (desktopHost() && command.startsWith('plugin:window|')) {
      const actions: Record<string, string> = {
        'plugin:window|close': 'close',
        'plugin:window|minimize': 'minimize',
        'plugin:window|is_maximized': 'isMaximized',
        'plugin:window|toggle_maximize': 'toggleMaximize',
      }
      const action = actions[command]
      if (action) return desktopHost()?.windowAction(action)
    }
    if (
      command === 'local_executor_ensure_started' ||
      command === 'local_executor_status' ||
      command === 'local_executor_connect_backend' ||
      command === 'local_executor_disconnect_backend'
    ) {
      return runtime.status()
    }
    if (command === 'local_executor_request') {
      return runtime.request(text(args.method) ?? '', args.params, {
        signal: args.signal instanceof AbortSignal ? args.signal : undefined,
      })
    }
    if (command === LEGACY_KCODER_STUDIO_TAURI_COMMANDS.readRuntimeConfig) {
      return readGatewayRuntimeConfig()
    }
    if (command === LEGACY_KCODER_STUDIO_TAURI_COMMANDS.updateRuntimeConfig) {
      return updateGatewayRuntimeConfig(args.patch)
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
      return runtime.controlBrowser(args.label, {
        action: 'navigate',
        url: text(args.url),
      })
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
    if (command === 'embedded_browser_page_state') {
      return runtime.readBrowserPageState(args.label)
    }
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
