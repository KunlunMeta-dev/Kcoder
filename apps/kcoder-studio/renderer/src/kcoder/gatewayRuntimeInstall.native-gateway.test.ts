import { afterEach, describe, expect, test, vi } from 'vitest'
import { installGatewayIpc } from './gatewayRuntimeInstall'
import {
  emitRuntimeEvent,
  invokeRuntimeCommand,
  subscribeRuntimeEvent,
} from './gatewayServiceBridge'
import {
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  LOCAL_EXECUTOR_EVENT,
} from '@/tauri/localExecutor'
import { getAppPreferences, updateAppPreferences } from '@/tauri/appPreferences'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
  vi.unstubAllGlobals()
})

function readonlyNativeHost(withToken = true) {
  const nativeInvoke = vi.fn(async () => ({ native: true }))
  const internals = {}
  Object.defineProperties(internals, {
    invoke: { value: nativeInvoke, writable: false, configurable: false },
    metadata: {
      value: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      writable: false,
      configurable: false,
    },
  })
  const host = {
    isTauri: true,
    dispatchEvent: vi.fn(() => true),
    location: new URL('http://127.0.0.1:43210/'),
    __KCODER_AI_VERIFY__: {
      origin: 'http://127.0.0.1:43210',
      controlUrl: 'http://127.0.0.1:43211',
      token: 'a'.repeat(64),
    },
  }
  Object.defineProperties(host, {
    __TAURI_INTERNALS__: { value: internals, writable: false, configurable: false },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { value: {}, writable: false, configurable: false },
  })
  if (withToken) {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'owned-rpc-token'
    document.head.append(meta)
  }
  vi.stubGlobal('window', host)
  return { host, internals, nativeInvoke }
}

describe('explicit native Gateway service transport', () => {
  test('works with real readonly descriptors and restores native mode without touching globals', async () => {
    const { host, internals, nativeInvoke } = readonlyNativeHost()
    const before = Object.getOwnPropertyDescriptors(internals)
    const handler = vi.fn(async (command, args) => ({ command, args, runtime: 'kcoder' }))
    const cleanup = installGatewayIpc(handler)
    cleanups.push(cleanup)
    await expect(requestLocalExecutor('runtime.models.list')).resolves.toMatchObject({
      command: 'local_executor_request',
      args: { method: 'runtime.models.list' },
      runtime: 'kcoder',
    })
    expect(nativeInvoke).not.toHaveBeenCalled()
    cleanup()
    cleanup()
    expect(Object.getOwnPropertyDescriptors(internals)).toEqual(before)
    expect(Object.getOwnPropertyDescriptor(host, '__TAURI_INTERNALS__')?.value).toBe(internals)
    await expect(invokeRuntimeCommand('get_app_preferences')).rejects.toThrow(
      'Gateway service transport is unavailable'
    )
    Reflect.deleteProperty(host, '__KCODER_AI_VERIFY__')
    await expect(invokeRuntimeCommand('get_app_preferences')).resolves.toEqual({ native: true })
    expect(nativeInvoke).toHaveBeenCalledTimes(1)
  })

  test('requires both an explicit Gateway session and its Gateway token', () => {
    const { nativeInvoke } = readonlyNativeHost(false)
    expect(() => installGatewayIpc(async () => null)).toThrow(
      'Gateway verification requires a Gateway token'
    )
    expect(nativeInvoke).not.toHaveBeenCalled()
  })

  test('application preferences use the same Gateway handler instead of native IPC', async () => {
    const { nativeInvoke } = readonlyNativeHost()
    const preferences = { language: 'zh-CN' }
    cleanups.push(
      installGatewayIpc(async (command, args) => {
        if (command === 'get_app_preferences') return preferences
        if (command === 'update_app_preferences') {
          Object.assign(preferences, (args as { patch: object }).patch)
          return preferences
        }
        throw new Error('unsupported')
      })
    )
    expect((await getAppPreferences()).language).toBe('zh-CN')
    expect((await updateAppPreferences({ language: 'en' })).language).toBe('en')
    expect(nativeInvoke).not.toHaveBeenCalled()
  })

  test('events are local to one registration and unsubscribe and stale cleanup are isolated', async () => {
    readonlyNativeHost()
    const firstCleanup = installGatewayIpc(async () => 'first')
    cleanups.push(firstCleanup)
    const firstListener = vi.fn()
    const unlisten = await subscribeLocalExecutorEvents(firstListener)
    await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, { event: 'first', payload: {} })
    expect(firstListener).toHaveBeenCalledTimes(1)
    unlisten()
    await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, { event: 'ignored', payload: {} })
    expect(firstListener).toHaveBeenCalledTimes(1)
    await subscribeRuntimeEvent(LOCAL_EXECUTOR_EVENT, firstListener)
    const secondCleanup = installGatewayIpc(async () => 'second')
    cleanups.push(secondCleanup)
    const secondListener = vi.fn()
    await subscribeRuntimeEvent(LOCAL_EXECUTOR_EVENT, secondListener)
    firstCleanup()
    await expect(invokeRuntimeCommand('local_executor_status')).resolves.toBe('second')
    await emitRuntimeEvent(LOCAL_EXECUTOR_EVENT, { event: 'second', payload: {} })
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)
  })

  test('unsupported Gateway commands fail rather than falling through to native IPC', async () => {
    const { nativeInvoke } = readonlyNativeHost()
    cleanups.push(
      installGatewayIpc(async () => {
        throw new Error('unsupported Gateway operation')
      })
    )
    await expect(invokeRuntimeCommand('open_local_file')).rejects.toThrow(
      'unsupported Gateway operation'
    )
    expect(nativeInvoke).not.toHaveBeenCalled()
  })
})
