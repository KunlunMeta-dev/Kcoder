import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { createCodexLayersApi } from './gatewayMigrationCodexLayers'
const server = {
  id: 'owned',
  label: 'Owned',
  runtime: 'kcoder' as const,
  description: '',
  transport: 'ssh' as const,
  host: 'remote.test',
  workspacePath: '/owned',
}
const source = {
  sourceId: 'derived',
  kind: 'codex',
  displayName: 'Selected project snapshot',
  scope: 'codex-project-layers',
  formatRevision: 'codex-selected-layers/v1',
  availableCategories: ['provider'],
}
test('Codex uses an independent capability and exact read-only forwarding on old and new targets', async () => {
  const client = new FakeGatewayClient(null),
    support = vi
      .spyOn(client, 'supportsExperimental')
      .mockImplementation(name => name !== 'migrationCodexLayersV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [server],
      createClient: () => client,
    }),
    options = { signal: new AbortController().signal }
  try {
    for (const operation of ['select', 'read'])
      await expect(
        runtime.request(
          'runtime.migration.request',
          { deviceId: 'owned', method: `migration/codex/layers/${operation}`, params: {} },
          options
        )
      ).rejects.toThrow('migration_codex_layers_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await runtime.request(
      'runtime.migration.request',
      {
        deviceId: 'owned',
        method: 'migration/codex/layers/read',
        params: { target: { kind: 'source', sourceId: 'derived' } },
      },
      options
    )
    expect(request).toHaveBeenLastCalledWith(
      'migration/codex/layers/read',
      expect.anything(),
      options
    )
    await expect(
      runtime.request('runtime.migration.request', {
        deviceId: 'owned',
        method: 'migration/codex/layers/raw',
        params: {},
      })
    ).rejects.toThrow('migration_invalid_operation')
  } finally {
    await runtime.dispose()
  }
})
test('derived references must replace their original grant and cannot claim another kind/scope', async () => {
  const invoke = vi.fn(async () => ({ source, replacesSourceIds: ['original'] })),
    api = createCodexLayersApi(invoke as never)
  await expect(
    api.codexLayersSelect({ sourceId: 'original', includeProject: true })
  ).resolves.toMatchObject({ source })
  for (const value of [
    { source, replacesSourceIds: [] },
    { source: { ...source, kind: 'claude-code' }, replacesSourceIds: ['original'] },
    { source: { ...source, scope: 'user' }, replacesSourceIds: ['original'] },
    { source, replacesSourceIds: ['original', 'derived'] },
  ]) {
    invoke.mockResolvedValueOnce(value as never)
    await expect(
      api.codexLayersSelect({ sourceId: 'original', includeProject: true })
    ).rejects.toThrow('migration_invalid_response')
  }
})
