import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '',
  transport: 'ssh' as const, host: 'remote.test', workspacePath: '/owned' }

test('reparsing requires its own capability before preview or creation is forwarded', async () => {
  const client = new FakeGatewayClient(null)
  const support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationHistoryReinterpretationV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const controller = new AbortController(), options = { signal: controller.signal }
  const invoke = (operation: string) => runtime.request('runtime.migration.request', {
    deviceId: 'remote', method: `migration/history/reinterpret/${operation}`, params: { sourceJobId: 'old-job' },
  }, options)
  try {
    for (const operation of ['preview', 'create'])
      await expect(invoke(operation)).rejects.toThrow('migration_history_reinterpretation_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await invoke('preview')
    expect(request).toHaveBeenLastCalledWith('migration/history/reinterpret/preview', { sourceJobId: 'old-job' }, options)
    await invoke('create')
    expect(request).toHaveBeenLastCalledWith('migration/history/reinterpret/create', { sourceJobId: 'old-job' })
    await expect(invoke('repair')).rejects.toThrow('migration_invalid_operation')
  } finally { await runtime.dispose() }
})
