import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { GatewayRpcError } from './gatewayRpc'
import { TurnAcceptanceUnknownError } from './gatewayTurnReceipt'

describe.each([Runtime, InstalledRuntime])('accepted turn receipt recovery', RuntimeClass => {
  test.each([true, false])('preserves the first thread when initial acceptance reply is lost: accepted=%s', async accepted => {
    const client = new FakeGatewayClient('first-receipt-thread')
    const original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (method === 'turn/start') {
        await original(method, params)
        throw new GatewayRpcError('initial reply lost', -1, undefined, 'runtime-session', 'connection')
      }
      if (method === 'turn/receipt/read') {
        client.requests.push({ method, params })
        return { receipt: accepted ? { threadId: 'first-receipt-thread', turnId: 'turn-1', status: 'completed' } : null } as T
      }
      return original<T>(method, params)
    })
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const request = runtime.request('runtime.tasks.create', { taskId: 'first-receipt-task', clientMessageId: 'first-submission', executionRequest: { prompt: 'first input' } })
      if (accepted) await expect(request).resolves.toMatchObject({ accepted: true })
      else await expect(request).rejects.toBeInstanceOf(TurnAcceptanceUnknownError)
      expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
      expect(client.requests.filter(request => request.method === 'turn/receipt/read')).toHaveLength(1)
      expect(client.requests.some(request => request.method === 'thread/delete' || request.method === 'thread/dispose')).toBe(false)
    } finally { await runtime.dispose() }
  })

  test.each(['running', 'completed', 'failed', 'interrupted'])('queries the accepted %s attempt without sending again', async status => {
    const client = new FakeGatewayClient('receipt-thread')
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    const reconciled = vi.fn()
    window.addEventListener('kcoder:turn-receipt-reconciled', reconciled)
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'receipt-task', executionRequest: { prompt: 'original' } }) as { taskId: string }
      const original = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (method === 'turn/start') {
          await original(method, params)
          throw new GatewayRpcError('connection lost after acceptance', -1, undefined, 'runtime-session', 'connection')
        }
        if (method === 'turn/receipt/read') {
          client.requests.push({ method, params })
          return { receipt: { threadId: 'receipt-thread', turnId: 'turn-accepted', status } } as T
        }
        return original<T>(method, params)
      })
      const before = client.requests.length
      const result = await runtime.request('runtime.tasks.send', {
        taskId: created.taskId, deviceId: 'local', message: 'next', clientMessageId: 'submission-id', executionRequest: {},
      })
      expect(result).toMatchObject({ accepted: true })
      const sent = client.requests.slice(before)
      expect(sent.filter(request => request.method === 'turn/start')).toHaveLength(1)
      expect(sent.find(request => request.method === 'turn/receipt/read')?.params).toEqual({ threadId: 'receipt-thread', clientMessageId: 'submission-id' })
      expect(reconciled).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('kcoder:turn-receipt-reconciled', reconciled)
      await runtime.dispose()
    }
  })

  test.each([null, { threadId: 'receipt-thread', turnId: 'turn-1', status: 'unknown' },
    { threadId: 'receipt-thread', turnId: 'another-turn', status: 'completed' },
    { threadId: 'another-thread', turnId: 'turn-1', status: 'completed' }])('does not replay when receipt evidence is absent or unusable: %j', async receipt => {
    const client = new FakeGatewayClient('receipt-thread')
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { taskId: 'receipt-task', executionRequest: { prompt: 'original' } }) as { taskId: string }
      const original = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (method === 'turn/start') {
          await original(method, params)
          throw new GatewayRpcError('connection lost', -1, undefined, 'runtime-session', 'connection')
        }
        if (method === 'turn/receipt/read') { client.requests.push({ method, params }); return { receipt } as T }
        return original<T>(method, params)
      })
      const before = client.requests.length
      await expect(runtime.request('runtime.tasks.send', {
        taskId: created.taskId, deviceId: 'local', retryFromTurnId: 'turn-1', executionRequest: {},
      })).rejects.toBeInstanceOf(TurnAcceptanceUnknownError)
      const sent = client.requests.slice(before)
      expect(sent.filter(request => request.method === 'turn/start')).toHaveLength(1)
      expect(sent.find(request => request.method === 'turn/receipt/read')?.params).toEqual({ threadId: 'receipt-thread', retryOperationId: 'retry:receipt-thread:turn-1' })
    } finally { await runtime.dispose() }
  })
})
