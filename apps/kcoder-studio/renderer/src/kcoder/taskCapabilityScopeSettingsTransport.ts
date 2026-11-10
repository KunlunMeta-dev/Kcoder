import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import { isContract } from '../../../shared/generated/validator.mjs'
import { nativeConnectivityClient } from '@/features/connectivity/nativeTransport'
import type { ConnectionList } from '@/features/connectivity/types'
import type { TaskWorkspaceTarget } from './taskWorkspaceTransport'
import { readTaskCapabilitySourceObservations } from './taskCapabilitySourceObservations'
import type { IntegrationTaskCapabilitySourceDescriptor } from '../../../shared/generated/contracts'
import type { IntegrationRequest, IntegrationScope, IntegrationTaskCapabilitySourceChoicesPage, IntegrationTaskCapabilityScopeControlTarget, IntegrationTaskCapabilityScopeSelection, IntegrationTaskCapabilityScopeSnapshot, IntegrationTaskResourceBinding } from '../../../shared/generated/contracts'
import { isIntegrationReply, isIntegrationScope, isIntegrationOperationReceipt, isIntegrationTaskCapabilitySourceChoicesPage, isIntegrationTaskCapabilityScopeControlTarget, isIntegrationTaskCapabilityScopeSelection, isIntegrationTaskCapabilityScopeSnapshot } from '../../../shared/generated/contractGuards.mjs'

type Method = 'integrations/tasks/readTaskSources' | 'integrations/tasks/listTaskSourceChoices' | 'integrations/tasks/setTaskSources' | 'integrations/tasks/readTaskSourceOperation'
interface Pending { operationId: string; expectedRevision: number; selection: IntegrationTaskCapabilityScopeSelection; resourceBindings?: IntegrationTaskResourceBinding[] }
const tuple = (value: IntegrationTaskCapabilityScopeControlTarget) => JSON.stringify([value.initialAttempt.threadId, value.initialAttempt.turnId, value.initialAttempt.attemptId, value.runtimeOperationId ?? null])
const scopeIdentity = (value: IntegrationScope) => JSON.stringify([value.accountId, value.targetId, value.workspaceId, value.identityGeneration, value.targetRevision, value.organizationId ?? null])

/** A native public control still authorizes every mutation; this client only retains its original identity. */
export function createTaskCapabilityScopeSettingsTransport(target: TaskWorkspaceTarget, original: IntegrationTaskCapabilityScopeControlTarget, current: () => boolean) {
  if (!isIntegrationTaskCapabilityScopeControlTarget(original)) throw new Error('TASK_CAPABILITY_SCOPE_INVALID_TARGET')
  const owner = structuredClone(target), selected = structuredClone(original), account = captureAccountContextRevision(), pendingReads = new Set<AbortController>()
  let active = true, scopeKey: string | undefined
  const check = () => { if (!active || !current() || !account(owner.serverId)) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_OWNER_CHANGED') }
  const scope = async (signal: AbortSignal) => {
    check(); signal.throwIfAborted()
    const value = await requestLocalExecutor<unknown>('runtime.integrations.request', { ...owner, method: 'integrations/scope/read', params: {} }, { signal })
    check(); signal.throwIfAborted()
    if (!isIntegrationScope(value)) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_INVALID_REPLY')
    const next = scopeIdentity(value)
    if (scopeKey !== undefined && scopeKey !== next) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_OWNER_CHANGED')
    scopeKey = next
    return structuredClone(value) as IntegrationScope
  }
  const storageKey = () => { if (!scopeKey) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_OWNER_CHANGED'); return JSON.stringify(['kcoder-task-source-change-v1', owner, tuple(selected), scopeKey]) }
  const remembered = (): Pending | undefined => {
    const raw = window.sessionStorage.getItem(storageKey()); if (!raw) return undefined
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
    const record = value as Pending
    if (typeof record.operationId !== 'string' || record.operationId.length > 256 || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 1 || !isIntegrationTaskCapabilityScopeSelection(record.selection)) throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
    if (record.resourceBindings !== undefined && (!Array.isArray(record.resourceBindings) || record.resourceBindings.length > 64 || !record.resourceBindings.every(binding => isContract('IntegrationTaskResourceBinding', binding)))) throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
    return structuredClone(record)
  }
  const call = async (method: Method, payload: Record<string, unknown>, identity?: Pending, signal?: AbortSignal) => {
    check(); const abort = new AbortController(), cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort(); pendingReads.add(abort)
    try {
      const native = await scope(abort.signal)
      const request: IntegrationRequest = { contractVersion: 'parallel-v1', requestId: createRandomUuid(), scope: native, timeoutMs: 15000, payload,
        ...(identity ? { operationId: identity.operationId, expectedRevision: String(identity.expectedRevision) } : {}) }
      const response = await requestLocalExecutor<unknown>('runtime.integrations.request', { ...owner, method, params: request }, { signal: abort.signal })
      check(); abort.signal.throwIfAborted()
      if (!isIntegrationReply(response) || response.requestId !== request.requestId || response.operationId !== (identity?.operationId ?? null)) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_INVALID_REPLY')
      if (response.status !== 'completed' || response.error !== null || response.result === null) throw new Error(response.error?.code ?? 'TASK_CAPABILITY_SCOPE_SETTINGS_UNCONFIRMED')
      return response.result
    } finally { pendingReads.delete(abort); signal?.removeEventListener('abort', cancel) }
  }
  const snapshot = (value: unknown): IntegrationTaskCapabilityScopeSnapshot => {
    if (!isIntegrationTaskCapabilityScopeSnapshot(value) || value.threadId !== selected.initialAttempt.threadId || value.revision < 1) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_INVALID_REPLY')
    return structuredClone(value)
  }
  const reconcile = async (signal?: AbortSignal) => {
    const abort = new AbortController(); if (signal?.aborted) abort.abort(); await scope(abort.signal)
    const pending = remembered(); if (!pending) return undefined
    const value = await call('integrations/tasks/readTaskSourceOperation', { target: selected, operationId: pending.operationId }, undefined, signal)
    if (!isIntegrationOperationReceipt(value.operation) || value.operation.operationId !== pending.operationId || value.operation.port !== 'P-TASK' || value.operation.method !== 'setTaskSources' || scopeIdentity(value.operation.scope) !== scopeKey) throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
    if (value.operation.phase !== 'completed') throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
    const result = snapshot(value.snapshot); window.sessionStorage.removeItem(storageKey()); return result
  }
  const commit = async (selection: IntegrationTaskCapabilityScopeSelection, expectedRevision: number, signal?: AbortSignal, resourceBindings?: IntegrationTaskResourceBinding[]) => {
      if (!isIntegrationTaskCapabilityScopeSelection(selection) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('TASK_CAPABILITY_SCOPE_INVALID_SELECTION')
      if (resourceBindings !== undefined && (resourceBindings.length > 64 || !resourceBindings.every(binding => isContract('IntegrationTaskResourceBinding', binding)))) throw new Error('TASK_RESOURCE_INVALID_SELECTION')
      const abort = new AbortController(); if (signal?.aborted) abort.abort(); await scope(abort.signal)
      if (remembered()) throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
      const identity: Pending = { operationId: createRandomUuid(), expectedRevision, selection: structuredClone(selection), ...(resourceBindings !== undefined ? { resourceBindings: structuredClone(resourceBindings) } : {}) }
      window.sessionStorage.setItem(storageKey(), JSON.stringify(identity))
      const value = await call('integrations/tasks/setTaskSources', { target: selected, params: { threadId: selected.initialAttempt.threadId, selection: identity.selection, ...(identity.resourceBindings !== undefined ? { resourceBindings: identity.resourceBindings } : {}) } }, identity, signal)
      if (!isIntegrationOperationReceipt(value.operation) || value.operation.operationId !== identity.operationId || value.operation.phase !== 'completed' || value.operation.port !== 'P-TASK' || value.operation.method !== 'setTaskSources' || scopeIdentity(value.operation.scope) !== scopeKey) throw new Error('TASK_CAPABILITY_SCOPE_ORIGINAL_OPERATION_UNCONFIRMED')
      const observed = snapshot(value.snapshot); window.sessionStorage.removeItem(storageKey()); return observed
    }
  const resourceChoices = async (after = '', signal?: AbortSignal): Promise<ConnectionList> => {
    const abort = new AbortController(), cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort(); pendingReads.add(abort)
    try { const native = await scope(abort.signal), client = nativeConnectivityClient(native, owner, { signal: abort.signal, isCurrent: () => active && current() && account(owner.serverId) }); const page = await client.call<ConnectionList>('P-CONNECTION', 'listConnections', { category: 'applications', after, limit: 10 }, { signal: abort.signal }); check(); return page }
    finally { pendingReads.delete(abort); signal?.removeEventListener('abort', cancel) }
  }
  return {
    async read(signal?: AbortSignal) { return snapshot(await call('integrations/tasks/readTaskSources', { target: selected, params: { threadId: selected.initialAttempt.threadId } }, undefined, signal)) },
    async choices(cursor?: string, catalogRevision?: string, signal?: AbortSignal): Promise<IntegrationTaskCapabilitySourceChoicesPage> {
      const value = await call('integrations/tasks/listTaskSourceChoices', { target: selected, ...(cursor ? { cursor, catalogRevision } : {}) }, undefined, signal)
      if (!isIntegrationTaskCapabilitySourceChoicesPage(value) || tuple(value.target) !== tuple(selected) || value.items.length > 10 || cursor && value.catalogRevision !== catalogRevision) throw new Error('TASK_CAPABILITY_SCOPE_SETTINGS_INVALID_REPLY')
      return structuredClone(value)
    },
    set: commit,
    async setResources(selection: IntegrationTaskCapabilityScopeSelection, resources: IntegrationTaskResourceBinding[], expectedRevision: number, signal?: AbortSignal) { return commit(selection, expectedRevision, signal, resources) },
    resourceChoices,
    async observations(descriptors: IntegrationTaskCapabilitySourceDescriptor[], signal?: AbortSignal) {
      const abort = new AbortController(), cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort(); pendingReads.add(abort)
      try {
        const result = await readTaskCapabilitySourceObservations(descriptors, () => resourceChoices('', abort.signal), async method => {
          await scope(abort.signal)
          const value = await requestLocalExecutor<unknown>('runtime.plugins.request', { deviceId: owner.serverId, workspacePath: owner.workspacePath, method, params: method === 'plugin/list' ? { all: true } : {} }, { signal: abort.signal })
          check(); abort.signal.throwIfAborted(); return value
        })
        check(); abort.signal.throwIfAborted(); return result
      }
      finally { pendingReads.delete(abort); signal?.removeEventListener('abort', cancel) }
    },
    reconcile,
    hasPending() { return scopeKey !== undefined && remembered() !== undefined },
    dispose() { active = false; for (const abort of pendingReads) abort.abort(); pendingReads.clear() },
  }
}
