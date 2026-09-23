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
  test('continues a failed logical turn with no prompt or attachment replay', async () => {
    const client = new FakeGatewayClient('thread-continue')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'continue-task',
        executionRequest: { prompt: 'original user request' },
      })) as { taskId: string }
      const before = client.requests.length
      await runtime.request('runtime.tasks.send', {
        taskId: created.taskId,
        deviceId: 'local',
        retryFromTurnId: 'turn-1',
        message: '',
        executionRequest: {},
      })
      const start = client.requests.slice(before).find(request => request.method === 'turn/start')
      expect(start?.params).toMatchObject({
        threadId: 'thread-continue',
        input: [],
        retryFromTurnId: 'turn-1',
        retryOperationId: 'retry:thread-continue:turn-1',
      })
      expect(start?.params.clientMessageId).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test('current settings retry requires identity and capability before mutating metadata', async () => {
    const client = new FakeGatewayClient('current-thread')
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { executionRequest: { prompt: 'original' } }) as { taskId: string }
      const params = { taskId: created.taskId, deviceId: 'local', retryFromTurnId: 'turn-1',
        retryFromAttemptId: 'turn-1', retryModelConfiguration: 'current',
        executionRequest: { model: 'new-model' }, modelSelection: { modelName: 'new-model' } }
      const supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(capability => capability !== 'retryModelConfigurationV1')
      const before = client.requests.length
      await expect(runtime.request('runtime.tasks.send', params)).rejects.toThrow()
      expect(client.requests.slice(before).some(row => ['turn/start', 'thread/metadata/update'].includes(row.method))).toBe(false)
      supports.mockReturnValue(true)
      await runtime.request('runtime.tasks.send', params)
      expect(client.requests.filter(row => row.method === 'turn/start').at(-1)?.params).toMatchObject({
        retryModelConfiguration: 'current', retryFromAttemptId: 'turn-1', model: 'new-model',
        retryOperationId: 'retry:current-thread:turn-1:current', input: [],
      })
      const starts = client.requests.filter(row => row.method === 'turn/start').length
      await expect(runtime.request('runtime.tasks.send', { ...params, retryFromAttemptId: undefined })).rejects.toThrow()
      expect(client.requests.filter(row => row.method === 'turn/start')).toHaveLength(starts)
    } finally { await runtime.dispose() }
  })

  test('identifies a repeated failure by its attempt and refuses old servers', async () => {
    const client = new FakeGatewayClient('attempt-thread')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const created = await runtime.request('runtime.tasks.create', {
        executionRequest: { prompt: 'once' },
      }) as { taskId: string }
      const params = { taskId: created.taskId, deviceId: 'local', retryFromTurnId: 'turn-1',
        retryFromAttemptId: 'turn-1-retry-abc', executionRequest: {} }
      await runtime.request('runtime.tasks.send', params)
      expect(client.requests.filter(row => row.method === 'turn/start').at(-1)?.params).toMatchObject({
        retryFromAttemptId: 'turn-1-retry-abc', retryOperationId: 'retry:attempt-thread:turn-1-retry-abc', input: [],
      })
      const count = client.requests.filter(row => row.method === 'turn/start').length
      vi.spyOn(client, 'supportsExperimental').mockImplementation(capability => capability !== 'turnAttemptRetryV1')
      await expect(runtime.request('runtime.tasks.send', params)).rejects.toThrow()
      expect(client.requests.filter(row => row.method === 'turn/start')).toHaveLength(count)
    } finally { await runtime.dispose() }
  })

  test.each(['failedTurnContinuationV1', 'turnRetryOperationV1'])(
    'does not resend the user prompt when %s capability is absent', async missingCapability => {
    const client = new FakeGatewayClient('thread-legacy-retry')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'legacy-retry-task',
        executionRequest: { prompt: 'original' },
      })) as { taskId: string }
      const original = client.supportsExperimental.bind(client)
      vi.spyOn(client, 'supportsExperimental').mockImplementation(
        capability => capability !== missingCapability && original(capability)
      )
      const before = client.requests.filter(request => request.method === 'turn/start').length
      await expect(
        runtime.request('runtime.tasks.send', {
          taskId: created.taskId,
          deviceId: 'local',
          retryFromTurnId: 'turn-1',
          message: '',
          executionRequest: {},
        })
      ).rejects.toThrow()
      expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(
        before
      )
    } finally {
      await runtime.dispose()
    }
  })
  test('forwards a declared re-submission so the server does not refuse it', async () => {
    const client = new FakeGatewayClient('thread-resubmit')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'resubmit-task',
        executionRequest: { prompt: 'original' },
      })) as { taskId: string }
      const before = client.requests.filter(request => request.method === 'turn/start').length
      await runtime.request('runtime.tasks.send', {
        taskId: created.taskId,
        deviceId: 'local',
        message: 'original',
        clientMessageId: 'client-message-1',
        resubmit: true,
        executionRequest: {},
      })
      const start = client.requests
        .filter(request => request.method === 'turn/start')
        .at(-1)
      expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(
        before + 1
      )
      expect(start?.params).toMatchObject({
        threadId: 'thread-resubmit',
        clientMessageId: 'client-message-1',
        resubmit: true,
      })

      // A first submission omits the intent instead of sending false.
      await runtime.request('runtime.tasks.send', {
        taskId: created.taskId,
        deviceId: 'local',
        message: 'another',
        clientMessageId: 'client-message-2',
        executionRequest: {},
      })
      const first = client.requests
        .filter(request => request.method === 'turn/start')
        .at(-1)
      expect(first?.params.clientMessageId).toBe('client-message-2')
      expect(first?.params.resubmit).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves local preflight error provenance for first and subsequent turn rejection', async () => {
    const received: Array<{
      event: string
      payload: { type?: string; data: Record<string, unknown> }
    }> = []
    const unlisten = await listen<(typeof received)[number]>('local-executor:event', event =>
      received.push(event.payload)
    )
    const client = new FakeGatewayClient('thread-local-failed')
    const originalRequest = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start')
        throw new GatewayRpcError('Storage initialization failed', -32603, {
          error_type: 'local_runtime_error',
        })
      return originalRequest(method, params)
    })
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await runtime.request('runtime.tasks.create', {
        taskId: 'local-failed-task',
        executionRequest: { prompt: 'hello' },
      })
      await expect(
        runtime.request('runtime.tasks.send', {
          taskId: 'local-failed-task',
          deviceId: 'local',
          executionRequest: { prompt: 'retry' },
        })
      ).rejects.toThrow()
      expect(received.filter(event => event.event === 'response.failed')).toMatchObject([
        {
          payload: {
            type: 'local_runtime_error',
            data: { message: 'Storage initialization failed' },
          },
        },
        {
          payload: {
            type: 'local_runtime_error',
            data: { message: 'Storage initialization failed' },
          },
        },
      ])
    } finally {
      unlisten()
      await runtime.dispose()
    }
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
          attemptId: 'turn-1-retry-prior',
          continuedByAttemptId: 'turn-1-retry-next',
        },
      ]
      await expect(
        runtime.request('runtime.tasks.transcript', { taskId: 'failed-task', deviceId: 'local' })
      ).resolves.toMatchObject({
        messages: [{ providerFailure: facts, errorType: 'invalid_parameter', attemptId: 'turn-1-retry-prior', continuedByAttemptId: 'turn-1-retry-next' }],
      })
    } finally {
      unlisten()
      await runtime.dispose()
    }
  })
})
