import { expect, it, vi } from 'vitest'
import { createResourceAttachmentApi, RESOURCE_ATTACHMENT_CAPABILITY, RESOURCE_ATTACHMENT_METHODS, validResourceAttachment } from '../../../shared/migrationResourceAttachment'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 }
const pending = { jobId: 'mig-owned', ownerJobId: 'mig-owned', currentSequence: 9, currentPlanId: 'plan-owned', phase: 'pending' as const, originalIntent: { expectedSequence: 2, planId: 'plan-owned', initialLimits: limits }, issueCode: null }
it('validates the original proof without replacing it with current sequence or policy facts', async () => {
  const invoke = vi.fn().mockResolvedValue(pending), api = createResourceAttachmentApi(invoke)
  await expect(api.batchResourceAttachmentRead({ jobId: pending.jobId })).resolves.toEqual(pending)
  for (const result of [{ ...pending, jobId: 'peer' }, { ...pending, ownerJobId: 'peer' }, { ...pending, originalIntent: null }, { ...pending, originalIntent: { ...pending.originalIntent, expectedSequence: 10 } }, { ...pending, originalIntent: { ...pending.originalIntent, planId: 'peer' } }]) {
    expect(validResourceAttachment(RESOURCE_ATTACHMENT_METHODS.batch, { jobId: pending.jobId }, result)).toBe(false)
  }
  expect(validResourceAttachment(RESOURCE_ATTACHMENT_METHODS.history, { jobId: pending.jobId }, { ...pending, phase: 'parent_owned', ownerJobId: 'mig-parent', originalIntent: null })).toBe(true)
})
it('uses an independent capability, finite method and read-only abort lane before Native', async () => {
  const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.test', workspacePath: '/owned' }
  const client = new FakeGatewayClient(null), supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== RESOURCE_ATTACHMENT_CAPABILITY), request = vi.spyOn(client, 'request').mockResolvedValue(pending as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const params = { deviceId: target.id, method: RESOURCE_ATTACHMENT_METHODS.batch, params: { jobId: pending.jobId } }, options = { signal: new AbortController().signal }
  try {
    await expect(runtime.request('runtime.migration.request', params, options)).rejects.toThrow('migration_resource_budget_update_required')
    expect(request).not.toHaveBeenCalled(); supports.mockReturnValue(true)
    await expect(runtime.request('runtime.migration.request', params, options)).resolves.toEqual(pending)
    expect(request).toHaveBeenLastCalledWith(RESOURCE_ATTACHMENT_METHODS.batch, { jobId: pending.jobId }, options)
  } finally { await runtime.dispose() }
})
