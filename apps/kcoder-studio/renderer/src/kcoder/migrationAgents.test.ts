import { expect, it, vi } from 'vitest'
import { AgentChoiceController, AGENT_CAPABILITY, AGENT_PREVIEW_METHOD, createAgentApi, hasAgentAdaptations, validAgentPreview } from '../../../shared/migrationAgents'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'
import type { MigrationAgentPreviewResult } from '../../../shared/generated/contracts'
const locator = { jobId: 'original-job', itemId: 'original-agent' }
const preview: MigrationAgentPreviewResult = { ...locator, compatibility: { sourceSha256: 'a'.repeat(64), canAdapt: true, availableTools: ['read', 'grep'], sourceModelReference: true, problem: null } }
it('binds compatibility to original bytes and rejects privilege fields, foreign items and contradictory reports', () => {
  expect(validAgentPreview(locator, preview)).toBe(true)
  for (const value of [{ ...preview, itemId: 'peer' }, { ...preview, permissionMode: 'bypass' },
    { ...preview, compatibility: { ...preview.compatibility, availableTools: ['AskUserQuestion'] } },
    { ...preview, compatibility: { ...preview.compatibility, problem: 'unsupported_tools' } }]) expect(validAgentPreview(locator, value)).toBe(false)
})
it('requires explicit model choice and review, preserves tool restrictions, and invalidates review on edits', async () => {
  const model = new AgentChoiceController({ agentPreview: vi.fn(async () => preview) }, locator, () => true)
  model.activate(); expect(model.ready()).toBe(true); model.change({ enabled: true }); expect(model.ready()).toBe(false)
  await model.read(); expect(model.value()).toBeNull(); model.change({ kind: 'target', provider: 'mapped', model: 'review-model' }); model.confirm(true)
  expect(model.value()).toEqual({ reviewedSourceSha256: 'a'.repeat(64), model: { kind: 'target', provider: 'mapped', model: 'review-model' }, tools: ['read', 'grep'] })
  model.change({ tools: ['write'] }); model.confirm(true); expect(model.value()).toBeNull()
  model.change({ tools: ['read'], provider: 'current' }); model.confirm(true); expect(model.value()).toBeNull()
  model.change({ kind: 'inherit' }); expect(model.value()).toBeNull(); model.confirm(true); expect(model.value()?.model).toEqual({ kind: 'inherit' })
  model.dispose()
})
it('drops late results and does not make unsupported definitions executable', async () => {
  let resolve!: (value: MigrationAgentPreviewResult) => void
  const pending = new Promise<MigrationAgentPreviewResult>(yes => { resolve = yes })
  const model = new AgentChoiceController({ agentPreview: () => pending }, locator, () => true)
  model.activate(); const read = model.read(); model.dispose(); resolve(preview); await read; expect(model.snapshot().result).toBeUndefined()
  const unsupported = new AgentChoiceController({ agentPreview: async () => ({ ...preview, compatibility: { ...preview.compatibility, canAdapt: false, availableTools: [], problem: 'unsupported_semantics' } }) }, locator, () => true)
  unsupported.activate(); unsupported.change({ enabled: true }); await unsupported.read(); unsupported.change({ kind: 'inherit' }); unsupported.confirm(true)
  expect(unsupported.ready()).toBe(false); unsupported.change({ enabled: false }); expect(unsupported.ready()).toBe(true); unsupported.dispose()
})
it('gates both preview and new batch fields on the independent native capability before dispatch', async () => {
  const target = { id: 'remote', label: 'Remote', runtime: 'kcoder' as const, description: '', transport: 'ssh' as const, host: 'owned.invalid' }
  const client = new FakeGatewayClient(null), supports = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== AGENT_CAPABILITY)
  const request = vi.spyOn(client, 'request').mockResolvedValue(preview as never)
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [target], createClient: () => client })
  const invoke = (method: string, params: object) => runtime.request('runtime.migration.request', { deviceId: target.id, method, params })
  const plan = { jobId: locator.jobId, expectedSequence: 1, choices: [{ kind: 'asset', itemId: locator.itemId, targetName: 'review', agentAdaptation: { reviewedSourceSha256: 'a'.repeat(64), model: { kind: 'inherit' }, tools: ['read'] } }] }
  try {
    await expect(invoke(AGENT_PREVIEW_METHOD, locator)).rejects.toThrow('migration_agent_update_required')
    expect(hasAgentAdaptations(plan)).toBe(true); await expect(invoke('migration/batch/plan', plan)).rejects.toThrow('migration_agent_update_required')
    expect(request).not.toHaveBeenCalled(); supports.mockReturnValue(true)
    await expect(createAgentApi(invoke).agentPreview(locator)).resolves.toEqual(preview)
  } finally { await runtime.dispose() }
})
