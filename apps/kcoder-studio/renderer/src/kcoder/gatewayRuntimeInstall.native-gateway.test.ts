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
} from '@/host/localExecutor'
import { getAppPreferences, updateAppPreferences } from '@/host/appPreferences'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
  vi.unstubAllGlobals()
})

function verificationWindow(withToken = true) {
  const host = {
    dispatchEvent: vi.fn(() => true),
    location: new URL('http://127.0.0.1:43210/'),
    __KCODER_AI_VERIFY__: {
      origin: 'http://127.0.0.1:43210',
      controlUrl: 'http://127.0.0.1:43211',
      token: 'a'.repeat(64),
    },
  }
  if (withToken) {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'owned-rpc-token'
    document.head.append(meta)
  }
  vi.stubGlobal('window', host)
  return host
}

describe('explicit native Gateway service transport', () => {
  test('routes through its owned handler and rejects requests after cleanup', async () => {
    const host = verificationWindow()
    const handler = vi.fn(async (command, args) => ({ command, args, runtime: 'kcoder' }))
    const cleanup = installGatewayIpc(handler)
    cleanups.push(cleanup)
    await expect(requestLocalExecutor('runtime.models.list')).resolves.toMatchObject({
      command: 'local_executor_request',
      args: { method: 'runtime.models.list' },
      runtime: 'kcoder',
    })
    cleanup()
    cleanup()
    await expect(invokeRuntimeCommand('get_app_preferences')).rejects.toThrow(
      'Gateway service transport is unavailable'
    )
    Reflect.deleteProperty(host, '__KCODER_AI_VERIFY__')
    await expect(invokeRuntimeCommand('get_app_preferences')).rejects.toThrow('Gateway service transport is unavailable')
  })

  test('requires both an explicit Gateway session and its Gateway token', () => {
    verificationWindow(false)
    expect(() => installGatewayIpc(async () => null)).toThrow(
      'Gateway verification requires a Gateway token'
    )
  })

  test('application preferences use the same Gateway handler instead of native IPC', async () => {
    verificationWindow()
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
  })

  test('events are local to one registration and unsubscribe and stale cleanup are isolated', async () => {
    verificationWindow()
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
    verificationWindow()
    cleanups.push(
      installGatewayIpc(async () => {
        throw new Error('unsupported Gateway operation')
      })
    )
    await expect(invokeRuntimeCommand('open_local_file')).rejects.toThrow(
      'unsupported Gateway operation'
    )
  })
})
