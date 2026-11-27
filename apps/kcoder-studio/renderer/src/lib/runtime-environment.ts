import { hasRuntimeTransport } from './runtime-transport'

export function isGatewayRuntime(): boolean {
  return hasRuntimeTransport()
}

// macOS-only window decoration (traffic-light buttons) requires the titlebar to step aside; Windows/Linux do not.
export function isMacOSRuntime(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent)
}
