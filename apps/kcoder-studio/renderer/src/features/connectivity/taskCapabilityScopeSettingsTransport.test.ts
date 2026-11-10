import { beforeEach, expect, test, vi } from 'vitest'
import { createTaskCapabilityScopeSettingsTransport } from '@/kcoder/taskCapabilityScopeSettingsTransport'
import { requestLocalExecutor } from '@/host/localExecutor'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const execute = vi.mocked(requestLocalExecutor), owner = { serverId: 'local', workspacePath: '/owned-workspace' }
const scope = { accountId: 'owned', targetId: 'target', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' }
const target = { initialAttempt: { threadId: 'original-thread', turnId: 'original-turn', attemptId: 'original-attempt' } }
const snapshot = { threadId: 'original-thread', revision: 2, selection: { mode: 'none', sources: [] }, effectiveSources: [], effectiveFrom: 'current_snapshot' }
function reply(request: Record<string, unknown>, result: unknown) { return { contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, entityRevision: null, status: 'completed', observedAt: '2026-10-25T00:00:00Z', result, error: null } }
beforeEach(() => { execute.mockReset(); sessionStorage.clear() })
test('choices retains the original tuple and rejects a foreign task catalog', async () => {
  let foreign = false
  execute.mockImplementation(async (_name, raw) => { const call = raw as { method: string; params: Record<string, unknown> }; if (call.method === 'integrations/scope/read') return scope
    return reply(call.params, { target: foreign ? { ...target, initialAttempt: { ...target.initialAttempt, attemptId: 'foreign-attempt' } } : target, catalogRevision: 'actual-catalog', catalogState: 'observed', items: [], nextCursor: null }) })
  const client = createTaskCapabilityScopeSettingsTransport(owner, target, () => true)
  expect((await client.choices()).target).toEqual(target)
  expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'integrations/tasks/listTaskSourceChoices', params: { payload: { target } } })
  foreign = true; await expect(client.choices()).rejects.toThrow(); client.dispose()
})
test('lost save survives view replacement and only reads the original operation before another intent', async () => {
  let originalOperation = '', writes = 0
  execute.mockImplementation(async (_name, raw) => { const call = raw as { method: string; params: Record<string, unknown> }; if (call.method === 'integrations/scope/read') return scope
    if (call.method.endsWith('/setTaskSources')) { writes++; originalOperation = String(call.params.operationId); throw new Error('controlled lost acknowledgment') }
    const payload = call.params.payload as { operationId: string }; expect(payload.operationId).toBe(originalOperation)
    return reply(call.params, { snapshot, operation: { operationId: originalOperation, scope, port: 'P-TASK', method: 'setTaskSources', revision: 3, phase: 'completed', createdAtMs: 1, updatedAtMs: 2, entityRef: null, error: null } }) })
  const first = createTaskCapabilityScopeSettingsTransport(owner, target, () => true)
  await expect(first.set({ mode: 'none', sources: [] }, 1)).rejects.toThrow(); first.dispose()
  const next = createTaskCapabilityScopeSettingsTransport(owner, target, () => true)
  await expect(next.set({ mode: 'inherit_current', sources: [] }, 1)).rejects.toThrow('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
  expect(writes).toBe(1); expect(await next.reconcile()).toEqual(snapshot); expect(next.hasPending()).toBe(false); expect(writes).toBe(1); next.dispose()
})

test('resource selection retains exact original refs in the same pending operation and never replays', async () => {
  const resources = [{ source: { sourceRef: { id: 'source', revision: 'source-v1' }, accountRef: null }, connectionRef: { id: 'application', revision: '3' }, resourceRefs: [{ id: 'granted-ref', revision: '2', kind: 'document' }] }]
  let writes = 0, operation = ''
  execute.mockImplementation(async (_name, raw) => {
    const call = raw as { method: string; params: Record<string, unknown> }
    if (call.method === 'integrations/scope/read') return scope
    if (call.method.endsWith('/setTaskSources')) { writes++; operation = String(call.params.operationId); expect(call.params.payload).toMatchObject({ target, params: { resourceBindings: resources } }); throw new Error('controlled lost original resource receipt') }
    expect(call.params.payload).toEqual({ target, operationId: operation })
    return reply(call.params, { snapshot: { ...snapshot, resourceBindings: resources, effectiveResourceBindings: resources }, operation: { operationId: operation, scope, port: 'P-TASK', method: 'setTaskSources', revision: 3, phase: 'completed', createdAtMs: 1, updatedAtMs: 2, entityRef: null, error: null } })
  })
  const first = createTaskCapabilityScopeSettingsTransport(owner, target, () => true)
  await expect(first.setResources({ mode: 'none', sources: [] }, resources, 1)).rejects.toThrow(); first.dispose()
  const restored = createTaskCapabilityScopeSettingsTransport(owner, target, () => true)
  await expect(restored.setResources({ mode: 'none', sources: [] }, [], 1)).rejects.toThrow('ORIGINAL_OPERATION_UNCONFIRMED')
  expect(writes).toBe(1); expect((await restored.reconcile())?.effectiveResourceBindings).toEqual(resources); expect(writes).toBe(1); restored.dispose()
})
