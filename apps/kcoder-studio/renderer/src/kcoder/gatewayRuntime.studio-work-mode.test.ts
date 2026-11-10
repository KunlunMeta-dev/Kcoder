import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { setInlineWidgetsEnabled, setStudioWorkMode } from '@/features/workbench/studioWorkMode'

class OfficeClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'tools/catalog') {
      this.requests.push({ method, params })
      return { tools: [] } as T
    }
    const result = await super.request<T>(method, params)
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        ...(result as object),
        thread: { id: 'office-thread', studioWorkMode: 'kworker' },
      } as T
    return result
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe.each([Runtime, InstalledRuntime])('Studio work mode adapter', RuntimeClass => {
  test('office creation, directory and follow-up use the same mode even after the blank preference changes', async () => {
    const client = new OfficeClient('office-thread')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'office',
        studioWorkMode: 'kworker',
        executionRequest: { prompt: '整理资料' },
      })) as { taskId: string; runtimeHandle: { studioWorkMode: string } }
      expect(created.runtimeHandle.studioWorkMode).toBe('kworker')
      const first = client.requests.find(request => request.method === 'turn/start')
      expect(first?.params.clientPresentation).toEqual({
        version: 1,
        studioWorkMode: 'kworker',
        inlineWidgets: true,
        isolatedWidgets: true,
      })
      setStudioWorkMode('kcoder')
      await runtime.request('runtime.tools.catalog', { taskId: created.taskId, serverId: 'local' })
      expect(
        client.requests.find(request => request.method === 'tools/catalog')?.params
          .clientPresentation
      ).toEqual(first?.params.clientPresentation)
      setInlineWidgetsEnabled(false)
      await runtime.request('runtime.tasks.send', { taskId: created.taskId, message: '继续' })
      expect(
        client.requests.filter(request => request.method === 'turn/start').at(-1)?.params
          .clientPresentation
      ).toEqual({ version: 1, studioWorkMode: 'kworker', inlineWidgets: false })
      expect(client.requests.filter(request => request.method === 'thread/start')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('an unconfirmed office mode fails before any turn rather than silently changing identity', async () => {
    const client = new FakeGatewayClient('legacy-thread')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.tasks.create', {
          taskId: 'unconfirmed',
          studioWorkMode: 'kworker',
          executionRequest: { prompt: 'office' },
        })
      ).rejects.toThrow()
      expect(client.requests.some(request => request.method === 'turn/start')).toBe(false)
      expect(client.requests.some(request => request.method === 'thread/delete')).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
