import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const target = {
  id: 'remote',
  label: 'Remote',
  runtime: 'kcoder' as const,
  description: '',
  transport: 'ssh' as const,
  host: 'remote.test',
  workspacePath: '/owned',
}
const params = { target: { kind: 'source' as const, sourceId: 'selected' }, pageIndex: 0 }
const response = {
  target: params.target,
  pageIndex: 0,
  status: 'available',
  adapterRevision: 'claude-settings-layers/v1',
  layers: [{ scope: 'user', present: true }],
  fields: [{ field: '/model', ordinal: 0, scopes: ['user'], private: false, supported: true }],
  totalFields: 1,
  nextPage: null,
  unobserved: [
    'managed_settings',
    'command_line_settings',
    'source_process_environment',
    'git_worktree_local_routing',
    'separate_mcp_namespaces',
  ],
}

test('layer reports require an independent capability and preserve abortable read semantics', async () => {
  const client = new FakeGatewayClient(null)
  const support = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => name !== 'migrationConfigurationLayersV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(response as never)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [target],
    createClient: () => client,
  })
  const options = { signal: new AbortController().signal }
  const invoke = (body: unknown = params) =>
    runtime.request(
      'runtime.migration.request',
      { deviceId: target.id, method: 'migration/configuration/layers', params: body },
      options
    )
  try {
    await expect(invoke()).rejects.toThrow('migration_configuration_layers_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await expect(invoke({ ...params, path: 'PRIVATE_PATH' })).rejects.toThrow(
      'migration_invalid_parameters'
    )
    expect(request).not.toHaveBeenCalled()
    await expect(invoke()).resolves.toEqual(response)
    expect(request).toHaveBeenLastCalledWith('migration/configuration/layers', params, options)
    for (const value of [
      { ...response, target: { kind: 'source', sourceId: 'other' } },
      { ...response, fields: [{ ...response.fields[0], field: 'PRIVATE_NAME' }] },
      { ...response, fields: Array(11).fill(response.fields[0]) },
      { ...response, nextPage: 0 },
    ]) {
      request.mockResolvedValueOnce(value as never)
      await expect(invoke()).rejects.toThrow('migration_invalid_response')
    }
  } finally {
    await runtime.dispose()
  }
})
