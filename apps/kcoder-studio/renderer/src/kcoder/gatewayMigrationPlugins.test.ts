import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const target = {
  id: 'remote-plugin',
  label: 'Remote',
  runtime: 'kcoder' as const,
  description: '',
  transport: 'ssh' as const,
  host: 'remote.test',
  workspacePath: '/owned',
}
test('plugin migration requires its own negotiated capability and never guesses support from provider migration', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationLocalPluginsV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: target.id,
        method: 'migration/plugin/plan',
        params: {},
      })
    ).rejects.toThrow('migration_plugins_update_required')
    expect(request).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})

test('uploaded plugin discovery cannot infer its new capability from ordinary plugin and uploaded-root support', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(
    capability => capability !== 'migrationSourceUploadedPluginsV1'
  )
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  try {
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: target.id,
        method: 'migration/plugin/discover',
        params: { sources: ['codex'], includeUploaded: true },
      })
    ).rejects.toThrow('migration_plugins_update_required')
    expect(request).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})
test('only explicit plugin observations forward abort signals; writes retain receipt ownership', async () => {
  const client = new FakeGatewayClient(null)
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  try {
    await runtime.request(
      'runtime.migration.request',
      {
        deviceId: target.id,
        method: 'migration/plugin/read',
        params: { operationId: 'operation' },
      },
      options
    )
    expect(request).toHaveBeenLastCalledWith(
      'migration/plugin/read',
      { operationId: 'operation' },
      options
    )
    await runtime.request(
      'runtime.migration.request',
      {
        deviceId: target.id,
        method: 'migration/plugin/apply',
        params: { operationId: 'operation', expectedSequence: 1 },
      },
      options
    )
    expect(request).toHaveBeenLastCalledWith('migration/plugin/apply', {
      operationId: 'operation',
      expectedSequence: 1,
    })
  } finally {
    await runtime.dispose()
  }
})
