import { invoke } from '@tauri-apps/api/core'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { KCoderGatewayRuntime } from './gatewayRuntime'
import {
  installGatewayRuntime,
  installGatewayIpc,
  type GatewayRuntimeInstallDependencies,
} from './gatewayRuntimeInstall'

type InstalledHandler = (command: string, payload?: unknown) => unknown

afterEach(() => clearMocks())

function installer(
  token: string | null = 'sensitive-token-value',
  ipcSlot: { handler: InstalledHandler | null } = { handler: null }
) {
  const calls: string[] = []
  const runtime = {
    dispose: vi.fn(() => calls.push('dispose')),
  } as unknown as KCoderGatewayRuntime
  const dependencies: GatewayRuntimeInstallDependencies = {
    readToken: vi.fn(() => {
      calls.push('token')
      return token
    }),
    createRuntime: vi.fn(() => {
      calls.push('runtime')
      return runtime
    }),
    installIpc: vi.fn(value => {
      calls.push('ipc')
      ipcSlot.handler = value
      return () => {
        calls.push('remove-ipc')
        if (ipcSlot.handler === value) ipcSlot.handler = null
      }
    }),
    registerWorkspaceRuntime: vi.fn(() => {
      calls.push('bridge')
      return () => calls.push('unregister')
    }),
    addBeforeUnload: vi.fn(() => calls.push('unload')),
    removeBeforeUnload: vi.fn(() => calls.push('remove-unload')),
  }
  return { calls, dependencies, runtime, handler: () => ipcSlot.handler }
}

describe('KCoder gateway runtime installer', () => {
  test('does not create mocks, runtime, bridge, or unload state without a token', () => {
    const fixture = installer(null)
    expect(installGatewayRuntime(fixture.dependencies)).toBeNull()
    expect(fixture.calls).toEqual(['token'])
  })

  test('installs IPC before publishing the bridge and cleans up idempotently', () => {
    const fixture = installer()
    const installation = installGatewayRuntime(fixture.dependencies)

    expect(installation?.runtime).toBe(fixture.runtime)
    expect(fixture.handler()).toBeTypeOf('function')
    expect(fixture.calls).toEqual(['token', 'runtime', 'ipc', 'bridge', 'unload'])
    installation?.cleanup()
    installation?.cleanup()
    expect(fixture.calls).toEqual([
      'token',
      'runtime',
      'ipc',
      'bridge',
      'unload',
      'remove-unload',
      'unregister',
      'remove-ipc',
      'dispose',
    ])
  })

  test('disposes the unpublished runtime when IPC installation fails', () => {
    const fixture = installer()
    fixture.dependencies.installIpc = () => {
      throw new Error('IPC mock installation failed')
    }

    expect(() => installGatewayRuntime(fixture.dependencies)).toThrow(
      'IPC mock installation failed'
    )
    expect(fixture.calls).toEqual(['token', 'runtime', 'dispose'])
    expect(fixture.calls.join(' ')).not.toContain('sensitive-token-value')
  })

  test('unregisters and disposes when unload publication fails', () => {
    const fixture = installer()
    fixture.dependencies.addBeforeUnload = () => {
      throw new Error('unload registration failed')
    }

    expect(() => installGatewayRuntime(fixture.dependencies)).toThrow('unload registration failed')
    expect(fixture.calls).toEqual([
      'token',
      'runtime',
      'ipc',
      'bridge',
      'remove-unload',
      'unregister',
      'remove-ipc',
      'dispose',
    ])
    expect(fixture.handler()).toBeNull()
  })

  test('removes IPC when bridge publication fails', () => {
    const slot = { handler: null as InstalledHandler | null }
    const fixture = installer('token', slot)
    fixture.dependencies.registerWorkspaceRuntime = () => {
      throw new Error('bridge registration failed')
    }

    expect(() => installGatewayRuntime(fixture.dependencies)).toThrow('bridge registration failed')
    expect(slot.handler).toBeNull()
    expect(fixture.calls).toEqual(['token', 'runtime', 'ipc', 'remove-ipc', 'dispose'])
  })

  test('removes IPC when unload publication fails', () => {
    const slot = { handler: null as InstalledHandler | null }
    const fixture = installer('token', slot)
    fixture.dependencies.addBeforeUnload = () => {
      throw new Error('unload registration failed')
    }

    expect(() => installGatewayRuntime(fixture.dependencies)).toThrow('unload registration failed')
    expect(slot.handler).toBeNull()
  })

  test('cleanup is idempotent and an old cleanup cannot clear a newer installation', () => {
    const slot = { handler: null as InstalledHandler | null }
    const first = installer('first', slot)
    const firstInstallation = installGatewayRuntime(first.dependencies)!
    const second = installer('second', slot)
    const secondInstallation = installGatewayRuntime(second.dependencies)!
    const secondHandler = slot.handler

    firstInstallation.cleanup()
    firstInstallation.cleanup()
    expect(slot.handler).toBe(secondHandler)
    secondInstallation.cleanup()
    secondInstallation.cleanup()
    expect(slot.handler).toBeNull()
    expect(first.calls.filter(call => call === 'dispose')).toHaveLength(1)
    expect(second.calls.filter(call => call === 'dispose')).toHaveLength(1)
  })

  test('restores the real Tauri mock stack without resurrecting a cleaned older handler', async () => {
    mockIPC(() => 'original')
    const firstCleanup = installGatewayIpc(() => 'first')
    const secondCleanup = installGatewayIpc(() => 'second')
    await expect(invoke('probe')).resolves.toBe('second')

    firstCleanup()
    await expect(invoke('probe')).resolves.toBe('second')
    secondCleanup()
    await expect(invoke('probe')).resolves.toBe('original')
  })

  test('installs IPC in a fresh browser window without pre-existing Tauri internals', async () => {
    const tauriWindow = window as typeof window & {
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
    }
    delete tauriWindow.__TAURI_INTERNALS__
    delete tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__

    const cleanup = installGatewayIpc(() => 'fresh')
    await expect(invoke('probe')).resolves.toBe('fresh')
    cleanup()
    expect(Object.prototype.hasOwnProperty.call(tauriWindow, '__TAURI_INTERNALS__')).toBe(false)
    expect(
      Object.prototype.hasOwnProperty.call(tauriWindow, '__TAURI_EVENT_PLUGIN_INTERNALS__')
    ).toBe(false)
  })

  test('restores original global objects and values after layered out-of-order cleanup', async () => {
    const tauriWindow = window as typeof window & {
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
    }
    const originalInvoke = vi.fn(() => 'original')
    const originalInternals = { invoke: originalInvoke, sentinel: { exact: true } }
    const originalEventInternals = { sentinel: 'event' }
    tauriWindow.__TAURI_INTERNALS__ = originalInternals
    tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = originalEventInternals
    const firstCleanup = installGatewayIpc(() => 'first')
    const secondCleanup = installGatewayIpc(() => 'second')

    firstCleanup()
    await expect(invoke('probe')).resolves.toBe('second')
    secondCleanup()
    expect(tauriWindow.__TAURI_INTERNALS__).toBe(originalInternals)
    expect(tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__).toBe(originalEventInternals)
    expect(tauriWindow.__TAURI_INTERNALS__).toEqual({
      invoke: originalInvoke,
      sentinel: { exact: true },
    })
    expect(tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__).toEqual({ sentinel: 'event' })
  })

  test('normal cleanup attempts every inverse operation and reports the first cleanup error', () => {
    const fixture = installer()
    const firstError = new Error('remove unload failed')
    fixture.dependencies.removeBeforeUnload = () => {
      fixture.calls.push('remove-unload-failed')
      throw firstError
    }
    fixture.dependencies.registerWorkspaceRuntime = () => {
      fixture.calls.push('bridge')
      return () => {
        fixture.calls.push('unregister-failed')
        throw new Error('unregister failed')
      }
    }
    fixture.dependencies.installIpc = () => {
      fixture.calls.push('ipc')
      return () => {
        fixture.calls.push('remove-ipc-failed')
        throw new Error('remove IPC failed')
      }
    }
    fixture.runtime.dispose = vi.fn(() => {
      fixture.calls.push('dispose-failed')
      throw new Error('dispose failed')
    })
    const installation = installGatewayRuntime(fixture.dependencies)!

    expect(() => installation.cleanup()).toThrow(firstError)
    expect(fixture.calls.slice(-4)).toEqual([
      'remove-unload-failed',
      'unregister-failed',
      'remove-ipc-failed',
      'dispose-failed',
    ])
  })

  test('preserves the original installation error after all rollback operations fail', () => {
    const fixture = installer()
    const installError = new Error('unload registration failed')
    fixture.dependencies.installIpc = () => {
      fixture.calls.push('ipc')
      return () => {
        fixture.calls.push('remove-ipc-failed')
        throw new Error('remove IPC failed')
      }
    }
    fixture.dependencies.registerWorkspaceRuntime = () => {
      fixture.calls.push('bridge')
      return () => {
        fixture.calls.push('unregister-failed')
        throw new Error('unregister failed')
      }
    }
    fixture.dependencies.addBeforeUnload = () => {
      throw installError
    }
    fixture.runtime.dispose = vi.fn(() => {
      fixture.calls.push('dispose-failed')
      throw new Error('dispose failed')
    })

    expect(() => installGatewayRuntime(fixture.dependencies)).toThrow(installError)
    expect(fixture.calls.slice(-3)).toEqual([
      'unregister-failed',
      'remove-ipc-failed',
      'dispose-failed',
    ])
  })
})
