import { clearMocks } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime as CoreRuntime } from './gatewayRuntime'
import { KCoderGatewayRuntime } from './installGatewayRuntime'

describe.each([
  ['installed', KCoderGatewayRuntime],
  ['shared', CoreRuntime],
] as const)('KCoder gateway catalog (%s)', (_entry, RuntimeConstructor) => {
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
  test('requires explicit node-contract capability before forwarding bindings or checks', async () => {
    const client = new FakeGatewayClient(null)
    let supported = false
    vi.spyOn(client, 'supportsExperimental').mockImplementation(
      capability => capability !== 'workflowNodeContractsV1' || supported
    )
    const request = vi.spyOn(client, 'request').mockResolvedValue({ id: 'saved' })
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [
        {
          id: 'local',
          label: 'Local',
          description: '',
          transport: 'local',
          workspacePath: '/workspace',
        },
      ],
      createClient: () => client,
    })
    for (const config of [
      { inputBindings: { rows: '/input/rows' } },
      { resultCheck: { source: 'return true;' } },
    ]) {
      await expect(
        runtime.request('runtime.workflows.request', {
          serverId: 'local',
          method: 'workflow/upsertNode',
          params: { node: { id: 'node', config } },
        })
      ).rejects.toThrow()
    }
    await expect(
      runtime.request('runtime.workflows.request', {
        serverId: 'local',
        method: 'workflow/import',
        params: { definition: { nodes: [{ id: 'node', config: { inputBindings: {} } }] } },
      })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith('workflow/upsertNode', expect.anything())
    expect(request).not.toHaveBeenCalledWith('workflow/import', expect.anything())
    supported = true
    await expect(
      runtime.request('runtime.workflows.request', {
        serverId: 'local',
        method: 'workflow/upsertNode',
        params: { node: { id: 'node', config: { resultCheck: { source: 'return true;' } } } },
      })
    ).resolves.toEqual({ id: 'saved' })
  })
  test('keeps unavailable workspaces visible without opening app-server clients for them', async () => {
    const connections: Array<string | undefined> = []
    const command = new FakeGatewayClient(null)
    command.threadResumeSupported = true
    command.workspaceItems = [
      {
        workspacePath: '/workspace/deleted-project',
        label: 'Deleted project',
        projectKey: 'deleted-project',
        projectSource: 'local_project',
        available: false,
      },
    ]
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
      createClient: (_serverId, _token, _channel, workspacePath) => {
        connections.push(workspacePath)
        if (workspacePath === undefined) return command
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        return client
      },
    })

    await expect(runtime.request('runtime.tasks.list', {})).resolves.toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspacePath: '/workspace/deleted-project',
          available: false,
          tasks: [],
        }),
      ]),
    })
    expect(connections).not.toContain('/workspace/deleted-project')
  })
})
