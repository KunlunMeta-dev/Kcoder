import { expect, it, vi } from 'vitest'
import { createHistoryResourceApi, HISTORY_RESOURCE_METHODS, validHistoryResourceCall } from '../../../shared/migrationHistoryResourceBudget'
import { createHistoryResourceController } from '../../../shared/migrationHistoryResourceController'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const jobId = '4c6d9ee9-d145-4da4-ac73-35c2dce251ea', requestId = '4c6d9ee9-d145-4da4-ac73-35c2dce251eb'
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 }
const snapshot = (ownerJobId: string | null = jobId) => ({ ownerJobId, initialLimits: limits, budget: { phase: 'active' as const, jobId, limits, policyRevision: 0, usage: { committedBytes: 0, reservedBytes: 0, committedFiles: 0, reservedFiles: 0 } } })
it('keeps owner and immutable initial limits distinct from a later raised current policy', async () => {
  const valid = snapshot(), changed = { ...valid, budget: { ...valid.budget, limits: { ...limits, maxTotalBytes: 8388608 }, policyRevision: 1 } }
  const invoke = vi.fn().mockResolvedValue(changed), api = createHistoryResourceApi(invoke)
  expect(await api.historyResourcesRead({ jobId })).toEqual(changed)
  for (const value of [{ ...valid, ownerJobId: null }, { ...valid, initialLimits: null }, { ...valid, budget: { ...valid.budget, jobId: 'peer' } }, { ...valid, initialLimits: { ...limits, maxTotalBytes: 8388608 } }, { ...valid, initialLimits: { ...limits, minFreeFileNodes: 1 } }]) {
    invoke.mockResolvedValueOnce(value)
    await expect(api.historyResourcesRead({ jobId })).rejects.toThrow('migration_invalid_response')
  }
  expect(validHistoryResourceCall(HISTORY_RESOURCE_METHODS.read, { jobId }, { ownerJobId: null, initialLimits: null, budget: { jobId, phase: 'legacy_untracked' } })).toBe(true)
})
it('gates every new operation and explicit history creation limits before Native; observation alone carries an abort signal', async () => {
  const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }
  const client = new FakeGatewayClient(null), support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== 'migrationHistoryResourceBudgetV1')
  const request = vi.spyOn(client, 'request').mockResolvedValue(snapshot() as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  try {
    for (const [method, params] of [[HISTORY_RESOURCE_METHODS.read, { jobId }], ['migration/history/create', { catalogId: 'catalog', sourceHandle: 'opaque', requestId, resourceLimits: limits }], [HISTORY_RESOURCE_METHODS.parentAttach, { jobId: 'mig-owned', planId: 'plan-owned', expectedSequence: 1, limits, confirm: true }]] as const) await expect(runtime.request('runtime.migration.request', { deviceId: target.id, method, params }, options)).rejects.toThrow('migration_resource_budget_update_required')
    expect(request).not.toHaveBeenCalled(); support.mockReturnValue(true)
    await runtime.request('runtime.migration.request', { deviceId: target.id, method: HISTORY_RESOURCE_METHODS.read, params: { jobId } }, options)
    expect(request).toHaveBeenLastCalledWith(HISTORY_RESOURCE_METHODS.read, { jobId }, options)
  } finally { await runtime.dispose() }
})
function fixture(owner = jobId) {
  const records = new Map<string, string>(), calls: object[] = []
  let observed = snapshot(owner), held = false
  const storage = { getItem: (key: string) => records.get(key) ?? null, refresh: async () => {}, withTransaction: async <T>(key: string, action: (local: {getItem(key: string): string | null; setItem(key: string, value: string): void}) => T) => { held = true; try { return action({ getItem: storage.getItem, setItem: (id, value) => records.set(id, value) }) } finally { held = false } } }
  const api = { read: vi.fn(async () => observed), increase: vi.fn(async (input: object) => { expect(held).toBe(false); calls.push(input); throw new Error('lost acknowledgement') }) }
  const options = { api, storage, scope: 'account-and-target', jobId, isCurrent: () => true, createRequestId: () => requestId }
  return { options, records, calls, api, observe(value: typeof observed) { observed = value } }
}
it('persists the complete increase before dispatch and reopens with reads only, without a synthetic plan on Native', async () => {
  const f = fixture(), first = createHistoryResourceController(f.options)
  await first.read(); await first.increase({ ...limits, maxPayloadFiles: 32 }, 0, true)
  expect(f.calls).toHaveLength(1); expect(f.calls[0]).not.toHaveProperty('planId')
  expect(first.getSnapshot().pending).toMatchObject({ requestId, expectedPolicyRevision: 0, limits: { ...limits, maxPayloadFiles: 32 } })
  first.dispose(); const reopened = createHistoryResourceController(f.options)
  await reopened.read(); expect(f.calls).toHaveLength(1)
  await reopened.resubmit(false); expect(f.calls).toHaveLength(1)
  await reopened.resubmit(true); expect(f.calls).toHaveLength(2); expect(f.calls[1]).toEqual(f.calls[0])
})
it('keeps a child bound to its parent read-only and fences target loss before persisting any new selector', async () => {
  const parent = fixture('mig-parent'), model = createHistoryResourceController(parent.options)
  await model.read(); await model.increase({ ...limits, maxPayloadFiles: 32 }, 0, true)
  expect(parent.calls).toHaveLength(0); expect(parent.records.size).toBe(0)
  const f = fixture(); let current = true
  const controller = createHistoryResourceController({ ...f.options, isCurrent: () => current })
  await controller.read(); current = false
  await controller.increase({ ...limits, maxPayloadFiles: 32 }, 0, true)
  expect(f.calls).toHaveLength(0); expect(f.records.size).toBe(0)
})
