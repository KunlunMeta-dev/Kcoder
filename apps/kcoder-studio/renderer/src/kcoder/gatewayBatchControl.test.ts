import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import { BATCH_CONTROL_CAPABILITY, BATCH_CONTROL_METHODS } from '../../../shared/migrationBatchControl'

const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'remote.test', workspacePath: '/owned' }
const observed = { jobId: 'job', currentSequence: 14, planId: 'plan', phase: 'tracked',
  generation: { planId: 'plan', runRequestId: 'run', admissionSequence: 3, mode: 'apply' },
  cancelRequested: false, lastCancellation: null, requestedReceipt: null }

test('new control methods require the independent capability without changing old cancellation', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockImplementation(cap => cap !== BATCH_CONTROL_CAPABILITY)
  const request = vi.spyOn(client, 'request').mockResolvedValue({} as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  try {
    await expect(runtime.request('runtime.migration.request', { deviceId: 'remote', method: BATCH_CONTROL_METHODS.read, params: { jobId: 'job' } })).rejects.toThrow('migration_batch_control_update_required')
    expect(request).not.toHaveBeenCalled()
    await runtime.request('runtime.migration.request', { deviceId: 'remote', method: 'migration/cancel', params: { jobId: 'job', expectedSequence: 14 } })
    expect(request).toHaveBeenCalledExactlyOnceWith('migration/cancel', { jobId: 'job', expectedSequence: 14 })
  } finally { await runtime.dispose() }
})

test('control observations are read-only and cancellation must return the exact original receipt', async () => {
  const client = new FakeGatewayClient(null)
  vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
  const request = vi.spyOn(client, 'request').mockResolvedValue(observed as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const intent = { jobId: 'job', planId: 'plan', runRequestId: 'run', admissionSequence: 3, commandId: '40000000-0000-4000-8000-000000000001' }
  try {
    await runtime.request('runtime.migration.request', { deviceId: 'remote', method: BATCH_CONTROL_METHODS.read, params: { jobId: 'job' } }, options)
    expect(request).toHaveBeenLastCalledWith(BATCH_CONTROL_METHODS.read, { jobId: 'job' }, options)
    await expect(runtime.request('runtime.migration.request', { deviceId: 'remote', method: BATCH_CONTROL_METHODS.cancel, params: intent }, options)).rejects.toThrow('migration_invalid_response')
    expect(request).toHaveBeenLastCalledWith(BATCH_CONTROL_METHODS.cancel, intent)
    request.mockResolvedValue({ ...observed, jobId: 'peer-job' } as never)
    await expect(runtime.request('runtime.migration.request', { deviceId: 'remote', method: BATCH_CONTROL_METHODS.read, params: { jobId: 'job' } })).rejects.toThrow('migration_invalid_response')
  } finally { await runtime.dispose() }
})
