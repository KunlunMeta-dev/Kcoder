import { describe, expect, test, vi } from 'vitest'
import { installGatewayPageRuntime, type KCoderGatewayRuntime } from './installGatewayRuntime'

function fixture(failAt: 'ipc' | 'unload') {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const runtime = { dispose: vi.fn(() => calls.push('dispose')) } as unknown as KCoderGatewayRuntime
  const dependencies = {
    readToken: () => 'owned-rpc-token',
    createRuntime: () => {
      calls.push('runtime')
      return runtime
    },
    installIpc: () => {
      calls.push('ipc')
      if (failAt === 'ipc') throw new Error('ipc installation failed')
      return () => {
        calls.push('remove-ipc')
      }
    },
    installNavigation: () => {
      calls.push('navigation')
      return () => {
        calls.push('remove-navigation')
      }
    },
    registerWorkspaceRuntime: () => {
      calls.push('workspace')
      return () => {
        calls.push('remove-workspace')
      }
    },
    addBeforeUnload: (listener: () => void) => {
      calls.push('unload')
      listeners.add(listener)
      throw new Error('unload installation failed')
    },
    removeBeforeUnload: (listener: () => void) => {
      calls.push('remove-unload')
      listeners.delete(listener)
    },
  }
  return { calls, listeners, runtime, dependencies }
}

describe('actual main.tsx Gateway page entry lifecycle', () => {
  test('IPC failure disposes the runtime before navigation or workspace publication', () => {
    const { calls, listeners, dependencies } = fixture('ipc')
    expect(() => installGatewayPageRuntime(dependencies)).toThrow('ipc installation failed')
    expect(calls).toEqual(['runtime', 'ipc', 'dispose'])
    expect(listeners.size).toBe(0)
  })

  test('partially installed beforeunload rolls back every resource without a TDZ callback', () => {
    const { calls, listeners, dependencies } = fixture('unload')
    expect(() => installGatewayPageRuntime(dependencies)).toThrow('unload installation failed')
    expect(listeners.size).toBe(0)
    expect(calls).toEqual([
      'runtime',
      'ipc',
      'navigation',
      'workspace',
      'unload',
      'remove-unload',
      'remove-workspace',
      'remove-navigation',
      'remove-ipc',
      'dispose',
    ])
  })
})
