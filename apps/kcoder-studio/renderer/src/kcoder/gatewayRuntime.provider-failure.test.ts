import { describe, expect, test, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { GatewayRpcError } from './gatewayRpc'

const facts = {
  category: 'invalid_parameter',
  recovery_action: 'needs_human',
  retryable: false,
  resume_safe: false,
  http_status: 400,
  retry_after_ms: 0,
}
describe.each([Runtime, InstalledRuntime])('typed provider failure runtime', RuntimeClass => {
  test('preserves local preflight error provenance for first and subsequent turn rejection', async () => {
    const received: Array<{ event: string; payload: { type?: string; data: Record<string, unknown> } }> = []
    const unlisten = await listen<(typeof received)[number]>('local-executor:event', event => received.push(event.payload))
    const client = new FakeGatewayClient('thread-local-failed')
    const originalRequest = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw new GatewayRpcError('Storage initialization failed', -32603, { error_type: 'local_runtime_error' })
      return originalRequest(method, params)
    })
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      await runtime.request('runtime.tasks.create', { taskId: 'local-failed-task', executionRequest: { prompt: 'hello' } })
      await expect(runtime.request('runtime.tasks.send', { taskId: 'local-failed-task', deviceId: 'local', executionRequest: { prompt: 'retry' } })).rejects.toThrow()
      expect(received.filter(event => event.event === 'response.failed')).toMatchObject([
        { payload: { type: 'local_runtime_error', data: { message: 'Storage initialization failed' } } },
        { payload: { type: 'local_runtime_error', data: { message: 'Storage initialization failed' } } },
      ])
    } finally { unlisten(); await runtime.dispose() }
  })
  test('projects item and terminal facts and preserves historical facts', async () => {
    const received: Array<{ event: string; payload: { data: Record<string, unknown> } }> = []
    const unlisten = await listen<(typeof received)[number]>('local-executor:event', event =>
      received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-failed')
    client.threadResumeSupported = true
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await runtime.request('runtime.tasks.create', {
        taskId: 'failed-task',
        executionRequest: { prompt: 'fail' },
      })
      const base = { threadId: 'thread-failed', turnId: 'thread-failed-turn' }
      client.emitNotification('item/event', {
        ...base,
        event: { type: 'error', error: 'HTTP 401 quota network', provider_failure: facts },
      })
      client.emitNotification('turn/completed', {
        ...base,
        turn: { id: base.turnId, status: 'failed' },
        error: { message: 'HTTP 401 quota network', details: facts },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(
        received
          .filter(event => event.event === 'response.failed')
          .map(event => event.payload.data.provider_failure)
      ).toEqual([facts, facts])
      client.threadMessages = [
        {
          id: 'failure',
          role: 'assistant',
          content: '',
          status: 'failed',
          error: 'HTTP 401',
          errorType: 'invalid_parameter',
          providerFailure: facts,
          turnId: base.turnId,
        },
      ]
      await expect(
        runtime.request('runtime.tasks.transcript', { taskId: 'failed-task', deviceId: 'local' })
      ).resolves.toMatchObject({
        messages: [{ providerFailure: facts, errorType: 'invalid_parameter' }],
      })
    } finally {
      unlisten()
      await runtime.dispose()
    }
  })
})
