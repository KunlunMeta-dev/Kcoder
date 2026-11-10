import { expect, it, vi } from 'vitest'
import { createResourceBudgetApi, validResourceCall } from './gatewayMigrationResources'
import { resourceBudgetDraft, resourceBudgetMutable } from '../../../shared/migrationResourceBudget'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const limits = { maxTotalBytes: 1024, maxPayloadFiles: 1, minFreeBytes: 1048576, minFreeFileNodes: 0 }
const current = (policyRevision = 0) => ({ phase: 'active' as const, jobId: 'mig-owned', limits, policyRevision, usage: { committedBytes: 0, reservedBytes: 0, committedFiles: 0, reservedFiles: 0 } })
const intent = { jobId: 'mig-owned', planId: 'plan-owned', requestId: 'request-owned', expectedPolicyRevision: 0, confirm: true, limits: { ...limits, maxPayloadFiles: 2 } }
const receipt = { jobId: intent.jobId, requestId: intent.requestId, previousRevision: 0, revision: 1, limits: intent.limits }
const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }
it('checks the independent capability before any budget Native request; only reads receive abort signals', async () => {
  const client = new FakeGatewayClient(null), support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationResourceBudgetV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(current() as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params }, options)
  try {
    await expect(invoke('migration/batch/resources/read', { jobId: intent.jobId })).rejects.toThrow('migration_resource_budget_update_required')
    await expect(invoke('migration/batch/scan', { sourceIds: [], resourceLimits: limits })).rejects.toThrow('migration_resource_budget_update_required')
    expect(request).not.toHaveBeenCalled(); support.mockReturnValue(true)
    await invoke('migration/batch/resources/read', { jobId: intent.jobId })
    expect(request).toHaveBeenLastCalledWith('migration/batch/resources/read', { jobId: intent.jobId }, options)
    request.mockResolvedValueOnce(receipt as never)
    await invoke('migration/batch/resources/increase', intent)
    expect(request).toHaveBeenLastCalledWith('migration/batch/resources/increase', intent)
  } finally { await runtime.dispose() }
})
it('validates matching job/request/CAS/full facts and distinguishes historical receipt from current policy', async () => {
  const invoke = vi.fn(), api = createResourceBudgetApi(invoke)
  for (const response of [undefined, { ...current(), jobId: 'peer' }, { phase: 'active', jobId: intent.jobId }, { ...current(), policyRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...current(), limits: { maxTotalBytes: 1 } }]) {
    invoke.mockResolvedValueOnce(response)
    await expect(api.resourcesRead({ jobId: intent.jobId })).rejects.toThrow('migration_invalid_response')
  }
  invoke.mockResolvedValueOnce({ ...current(3), limits: { ...limits, maxTotalBytes: 8192, maxPayloadFiles: 4 }, requestedReceipt: receipt })
  await expect(api.resourcesRead({ jobId: intent.jobId, requestId: intent.requestId })).resolves.toHaveProperty('policyRevision', 3)
  expect(validResourceCall('migration/batch/resources/read', { jobId: intent.jobId, requestId: 'peer' }, { ...current(3), requestedReceipt: receipt })).toBe(false)
  for (const changed of [{ ...receipt, requestId: 'peer' }, { ...receipt, revision: 2 }, { ...receipt, limits }]) {
    invoke.mockResolvedValueOnce(changed)
    await expect(api.resourcesIncrease(intent)).rejects.toThrow('migration_invalid_response')
  }
  const before = invoke.mock.calls.length
  await expect(api.resourcesIncrease({ ...intent, confirm: false })).rejects.toThrow('migration_invalid_parameters')
  await expect(api.resourcesIncrease({ ...intent, limits: { maxTotalBytes: 2048 } })).rejects.toThrow('migration_invalid_parameters')
  expect(invoke).toHaveBeenCalledTimes(before)
})
it('requires increased integers, carries unchanged free-space margins and fences actual batch lifecycle', () => {
  expect(resourceBudgetDraft(current(), '2048', '1')).toEqual({ ...limits, maxTotalBytes: 2048 })
  for (const [bytes, files] of [['1.5', '2'], ['1e9', '2'], ['1024', '1'], ['9007199254740992', '2'], ['2', '0']]) expect(resourceBudgetDraft(current(), bytes, files)).toBeNull()
  for (const status of ['completed', 'cancel_requested', 'cancelled', 'rolling_back', 'rolled_back', 'rollback_conflict']) expect(resourceBudgetMutable(status, 1)).toBe(false)
  expect(resourceBudgetMutable('completed_with_issues', 1)).toBe(true)
  expect(resourceBudgetMutable('completed_with_issues', 0)).toBe(false)
})

it('accepts committed payloads with no pending reservation and rejects only total over-admission', async () => {
  const response = { ...current(), usage: { committedBytes: 512, reservedBytes: 0, committedFiles: 1, reservedFiles: 0 } }
  const invoke = vi.fn().mockResolvedValueOnce(response), api = createResourceBudgetApi(invoke)
  await expect(api.resourcesRead({ jobId: intent.jobId })).resolves.toEqual(response)
  expect(validResourceCall('migration/batch/resources/read', { jobId: intent.jobId }, { ...response, usage: { ...response.usage, reservedBytes: 513 } })).toBe(false)
  expect(validResourceCall('migration/batch/resources/read', { jobId: intent.jobId }, { ...response, usage: { ...response.usage, reservedFiles: 1 } })).toBe(false)
})
