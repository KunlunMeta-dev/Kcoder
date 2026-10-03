import { clearMocks } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import {
  KCoderGatewayRuntime,
  readGatewayRuntimeConfig,
  updateGatewayRuntimeConfig,
} from './installGatewayRuntime'
import { KCODER_RUNTIME_METHODS } from './legacyRuntimeAbi'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway settings (%s)', (_entry, RuntimeConstructor) => {
  const runtimes = new Set<{ dispose(): void; disposeAsync?: () => Promise<void> }>()
  class KCoderGatewayRuntime extends RuntimeConstructor {
    constructor(...args: ConstructorParameters<typeof CoreRuntime>) {
      super(...args)
      runtimes.add(this)
    }
  }
  beforeEach(() => localStorage.clear())
  afterEach(async () => {
    await Promise.all([...runtimes].map(runtime => runtime.disposeAsync?.() ?? runtime.dispose()))
    runtimes.clear()
    clearMocks()
    vi.restoreAllMocks()
  })
  test('persists the remote apps setting instead of acknowledging a no-op write', () => {
    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(true)
    expect(updateGatewayRuntimeConfig({ remoteAppsEnabled: false }).remoteAppsEnabled).toBe(false)
    expect(readGatewayRuntimeConfig().remoteAppsEnabled).toBe(false)
    expect(updateGatewayRuntimeConfig({ unrelated: true }).remoteAppsEnabled).toBe(false)
  })

  test('persists keybinding overrides across runtime instances', async () => {
    const options = {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local' as const,
          workspacePath: '/workspace',
        },
      ],
      createClient: () => new FakeGatewayClient('unused'),
    }
    const runtime = new KCoderGatewayRuntime('token', options)
    await expect(
      runtime.request('runtime.keybindings.update', {
        keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
      })
    ).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
    const reloaded = new KCoderGatewayRuntime('token', options)
    await expect(reloaded.request('runtime.keybindings.get', {})).resolves.toEqual({
      keybindings: [{ command: 'task.new', shortcut: 'Ctrl+N' }],
    })
  })

  test('persists context settings, applies them to prompts, and rejects the obsolete unscoped hook catalog', async () => {
    const client = new FakeGatewayClient('thread-context')
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: '当前虚拟机',
          description: '本机',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })

    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.instructionsWrite, {
        instructions: '始终先运行测试',
      })
    ).resolves.toEqual({ instructions: '始终先运行测试', configPath: null })
    await expect(
      runtime.request(KCODER_RUNTIME_METHODS.personalityWrite, { personality: 'friendly' })
    ).resolves.toEqual({ personality: 'friendly' })
    await expect(runtime.request(KCODER_RUNTIME_METHODS.instructionsRead, {})).resolves.toEqual({
      instructions: '始终先运行测试',
      configPath: null,
    })
    await expect(runtime.request('runtime.hooks.list', {})).rejects.toMatchObject({
      data: { kind: 'hook_config_unsupported' },
    })

    await runtime.request('runtime.tasks.create', {
      taskId: 'context-task',
      executionRequest: { prompt: '实现功能' },
    })
    expect(client.requests.find(request => request.method === 'turn/start')).toMatchObject({
      params: {
        input: [
          {
            type: 'text',
            text: expect.stringContaining(
              '<kcoder_client_context personality="friendly">\n始终先运行测试'
            ),
          },
        ],
      },
    })
    runtime.dispose()
  })
})
