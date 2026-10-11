import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockWindows: vi.fn(),
  mockIPC: vi.fn(),
}))

vi.mock('@tauri-apps/api/mocks', () => mocks)

import { installGatewayIpc } from './gatewayRuntimeInstall'

describe('KCoder gateway IPC partial installation rollback', () => {
  beforeEach(() => {
    mocks.mockWindows.mockReset()
    mocks.mockIPC.mockReset()
  })

  test('restores both original global objects when mockIPC fails after mockWindows', () => {
    const tauriWindow = window as typeof window & {
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
    }
    const originalInternals = { sentinel: 'ipc' }
    const originalEventInternals = { sentinel: 'event' }
    tauriWindow.__TAURI_INTERNALS__ = originalInternals
    tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = originalEventInternals
    mocks.mockWindows.mockImplementation(() => {
      originalInternals.metadata = { currentWindow: { label: 'main' } }
    })
    const installError = new Error('mockIPC failed midway')
    mocks.mockIPC.mockImplementation(() => {
      originalInternals.invoke = vi.fn()
      originalEventInternals.unregisterListener = vi.fn()
      throw installError
    })

    expect(() => installGatewayIpc(() => undefined)).toThrow(installError)
    expect(tauriWindow.__TAURI_INTERNALS__).toBe(originalInternals)
    expect(tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__).toBe(originalEventInternals)
    expect(originalInternals).toEqual({ sentinel: 'ipc' })
    expect(originalEventInternals).toEqual({ sentinel: 'event' })
  })
})
