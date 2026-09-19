import { afterEach, describe, expect, test } from 'vitest'
import { isNativeTauriHost } from './runtime-environment'

type RuntimeWindow = typeof window & {
  __TAURI_INTERNALS__?: unknown
  __KCODER_GATEWAY_WEB_SHIM__?: boolean
}

const runtimeWindow = window as RuntimeWindow

afterEach(() => {
  delete runtimeWindow.__TAURI_INTERNALS__
  delete runtimeWindow.__KCODER_GATEWAY_WEB_SHIM__
})

describe('runtime environment', () => {
  test('does not mistake the Gateway Web IPC shim for a native Tauri host', () => {
    runtimeWindow.__TAURI_INTERNALS__ = { invoke: () => undefined }
    runtimeWindow.__KCODER_GATEWAY_WEB_SHIM__ = true

    expect(isNativeTauriHost()).toBe(false)
  })

  test('recognizes an unshimmed Tauri host', () => {
    runtimeWindow.__TAURI_INTERNALS__ = { invoke: () => undefined }

    expect(isNativeTauriHost()).toBe(true)
  })
})
