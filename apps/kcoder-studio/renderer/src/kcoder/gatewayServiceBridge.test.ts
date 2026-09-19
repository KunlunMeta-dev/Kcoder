import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RemoteTerminalClient } from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import {
  createGatewayTerminalClient,
  registerGatewayWorkspaceSessionRuntime,
  restoreGatewayTerminal,
  startGatewayTerminal,
  type GatewayWorkspaceSessionRuntime,
} from './gatewayServiceBridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function runtime(name: string): GatewayWorkspaceSessionRuntime {
  return {
    startTerminal: vi.fn(async (_deviceId, cwd) => ({
      session_id: `${name}-session`,
      cwd,
    })) as GatewayWorkspaceSessionRuntime['startTerminal'],
    restoreTerminal: vi.fn(async (_deviceId, cwd, sessionId) => ({
      session_id: sessionId,
      cwd,
    })) as GatewayWorkspaceSessionRuntime['restoreTerminal'],
    createTerminalClient: vi.fn(
      sessionId => ({ name, sessionId }) as unknown as RemoteTerminalClient
    ),
  }
}

describe('KCoder gateway workspace session bridge', () => {
  test('fails closed before a runtime is registered', async () => {
    await expect(startGatewayTerminal('local', '/workspace')).rejects.toThrow('尚未初始化')
    expect(() => createGatewayTerminalClient('missing')).toThrow('尚未初始化')
  })

  test('delegates terminal operations to the current runtime', async () => {
    const current = runtime('current')
    cleanups.push(registerGatewayWorkspaceSessionRuntime(current))

    await expect(startGatewayTerminal('local', '/workspace')).resolves.toEqual({
      session_id: 'current-session',
      cwd: '/workspace',
    } satisfies DeviceSessionResponse)
    await expect(
      restoreGatewayTerminal('local', '/workspace', 'current-persisted')
    ).resolves.toEqual({
      session_id: 'current-persisted',
      cwd: '/workspace',
    } satisfies DeviceSessionResponse)
    expect(createGatewayTerminalClient('wire-1')).toMatchObject({
      name: 'current',
      sessionId: 'wire-1',
    })
  })

  test('stale cleanup cannot clear a newer runtime', async () => {
    const firstCleanup = registerGatewayWorkspaceSessionRuntime(runtime('first'))
    const secondCleanup = registerGatewayWorkspaceSessionRuntime(runtime('second'))
    cleanups.push(firstCleanup, secondCleanup)

    firstCleanup()
    await expect(startGatewayTerminal('local')).resolves.toMatchObject({
      session_id: 'second-session',
    })
  })

  test('current cleanup makes the bridge unavailable', async () => {
    const cleanup = registerGatewayWorkspaceSessionRuntime(runtime('current'))
    cleanups.push(cleanup)
    cleanup()

    await expect(startGatewayTerminal('local')).rejects.toThrow('尚未初始化')
    expect(() => createGatewayTerminalClient('wire-1')).toThrow('尚未初始化')
  })
})


test('removed Gateway command transport rejects as cancellation instead of invoking a missing native bridge', async () => {
  const { invokeRuntimeCommand, registerGatewayCommandTransport } = await import('./gatewayServiceBridge')
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  document.head.append(meta)
  const cleanup = registerGatewayCommandTransport(() => 'ready')
  try {
    await expect(invokeRuntimeCommand('probe')).resolves.toBe('ready')
    cleanup()
    await expect(invokeRuntimeCommand('probe')).rejects.toMatchObject({ name: 'AbortError' })
  } finally { cleanup(); meta.remove() }
})


test('a live browser Gateway IPC bridge still serves commands without a command transport', async () => {
  const { invokeRuntimeCommand } = await import('./gatewayServiceBridge')
  const descriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  document.head.append(meta)
  const invoke = vi.fn().mockResolvedValue('browser bridge')
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, writable: true, value: { invoke } })
  try {
    await expect(invokeRuntimeCommand('probe')).resolves.toBe('browser bridge')
    expect(invoke).toHaveBeenCalled()
  } finally {
    if (descriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', descriptor)
    else Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    meta.remove()
  }
})
