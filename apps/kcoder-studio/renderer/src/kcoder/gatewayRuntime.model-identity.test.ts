import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('provider model wire identity', RuntimeClass => {
  test('resident conversation model catalogs use the existing thread snapshot', async () => {
    const client = new FakeGatewayClient('resident-model-thread')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      const created = (await runtime.request('runtime.tasks.create', {
        taskId: 'resident-model-task',
        executionRequest: { prompt: 'hello' },
      })) as { taskId: string }
      await runtime.request('runtime.models.list', { deviceId: 'local', taskId: created.taskId })
      expect(
        client.requests.filter(request => request.method === 'runtime.models.list').at(-1)?.params
          .threadId
      ).toBe('resident-model-thread')
    } finally {
      await runtime.dispose()
    }
  })

  test('routes a remote project catalog to its workspace and never connects the local default', async () => {
    const createClient = vi.fn(() => new FakeGatewayClient('catalog'))
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        localGatewayServer(),
        { ...localGatewayServer(), id: 'ssh', transport: 'ssh' as const, workspacePath: '/remote' },
      ],
      createClient,
    })
    try {
      await runtime.request('runtime.models.list', {
        deviceId: 'ssh',
        workspacePath: '/remote/project',
      })
      expect(createClient).toHaveBeenCalledWith('ssh', 'token', 'runtime', '/remote/project')
      expect(createClient).toHaveBeenCalledTimes(1)
      await expect(runtime.request('runtime.models.list', { deviceId: 'missing' })).rejects.toThrow(
        '未知'
      )
      expect(createClient).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })

  test.each([false, true])(
    'negotiates legacy single-model providers and refuses ambiguous catalogs (%s)',
    async ambiguous => {
      const client = new FakeGatewayClient('legacy-thread')
      const supports = client.supportsExperimental.bind(client)
      client.supportsExperimental = capability =>
        capability === 'qualifiedModelSelectionV1' ? false : supports(capability)
      const request = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (method, params) =>
        method === 'runtime.models.list'
          ? {
              providers: [
                {
                  id: 'second',
                  data: ambiguous ? [{ model: 'same' }, { model: 'other' }] : [{ model: 'same' }],
                },
              ],
            }
          : request(method, params)
      )
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      })
      try {
        const creation = runtime.request('runtime.tasks.create', {
          taskId: 'legacy-task',
          executionRequest: { prompt: 'hello', model_config: { model_id: 'second::same' } },
        })
        if (ambiguous) {
          await expect(creation).rejects.toThrow('升级')
          expect(client.requests.some(request => request.method === 'thread/start')).toBe(false)
        } else {
          await creation
          expect(
            client.requests.find(request => request.method === 'thread/start')?.params.model
          ).toBe('second')
          expect(
            client.requests.find(request => request.method === 'turn/start')?.params.model
          ).toBe('second')
        }
      } finally {
        await runtime.dispose()
      }
    }
  )
  test.each([
    ['same', 'first', 'first::same'],
    ['other', 'first', 'first::other'],
    ['same', 'second', 'second::same'],
    ['second::same', 'second', 'second::same'],
    ['legacy', undefined, 'legacy'],
  ])(
    'sends %s on %s without dropping or duplicating the provider',
    async (model, provider, selector) => {
      const client = new FakeGatewayClient('identity-thread')
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      })
      try {
        await runtime.request('runtime.tasks.create', {
          taskId: 'identity-task',
          executionRequest: {
            prompt: 'hello',
            model_config: { model_id: model, ...(provider ? { model_provider: provider } : {}) },
          },
        })
        expect(
          client.requests.find(request => request.method === 'thread/start')?.params.model
        ).toBe(selector)
        expect(client.requests.find(request => request.method === 'turn/start')?.params.model).toBe(
          selector
        )
      } finally {
        await runtime.dispose()
      }
    }
  )
})
