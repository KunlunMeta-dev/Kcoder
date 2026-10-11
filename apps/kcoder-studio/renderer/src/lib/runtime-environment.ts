import { isTauri as isTauriApiRuntime } from '@tauri-apps/api/core'

function hasTauriGlobal(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return isTauriApiRuntime() || hasTauriGlobal()
}

export function isNativeTauriHost(): boolean {
  if (typeof window === 'undefined') return false
  const gatewayWindow = window as typeof window & { __KCODER_GATEWAY_WEB_SHIM__?: boolean }
  return gatewayWindow.__KCODER_GATEWAY_WEB_SHIM__ !== true && isTauriRuntime()
}

// macOS-only window decoration (traffic-light buttons) requires the titlebar to step aside; Windows/Linux do not.
export function isMacOSRuntime(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent)
}
