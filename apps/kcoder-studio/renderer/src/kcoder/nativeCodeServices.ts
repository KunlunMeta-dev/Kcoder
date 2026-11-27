import type {
  IntegrationRequest,
  IntegrationScope,
  NativeCodeServiceMethod,
  NativeCodeServicePreparePayload,
  NativeCodeServiceRecord,
  NativeCodeServiceReadResult,
  NativeCodeServiceMutationResult,
} from '../../../shared/generated/contracts'
import { isContract } from '../../../shared/generated/validator.mjs'
import { integrationControlCapability } from '../../../shared/integrationControlMethods.mjs'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from './accountContextEvents'
import { createRandomUuid } from '@/lib/random-id'

/** Closing this observer cancels waits, never the user's explicitly approved service. */
export function nativeCodeServices(
  target: { serverId: string; workspacePath?: string },
  scope: IntegrationScope,
  isCurrent: () => boolean
) {
  const owner = structuredClone(scope)
  const scopeKey = JSON.stringify(owner)
  const accountCurrent = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  const check = () => {
    if (!active || !isCurrent() || !accountCurrent(target.serverId))
      throw new Error('NATIVE_CODE_SERVICE_SCOPE_CHANGED')
  }
  const call = async <T>(method: NativeCodeServiceMethod, payload: Record<string, unknown>,
    contract: string, operationId?: string, expectedRevision?: number, signal?: AbortSignal): Promise<T> => {
    check()
    if (integrationControlCapability(method) !== 'nativeCodeServicesV1')
      throw new Error('NATIVE_CODE_SERVICE_CAPABILITY_REQUIRED')
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    if (signal?.aborted) cancel.abort()
    signal?.addEventListener('abort', abort, { once: true })
    pending.add(cancel)
    const request: IntegrationRequest = { contractVersion: 'parallel-v1', requestId: createRandomUuid(),
      scope: owner, timeoutMs: 60000, payload, ...(operationId ? { operationId } : {}),
      ...(expectedRevision === undefined ? {} : { expectedRevision: String(expectedRevision) }) }
    try {
      cancel.signal.throwIfAborted()
      const result = await requestLocalExecutor<unknown>('runtime.integrations.request',
        { ...target, method, params: request }, { signal: cancel.signal })
      cancel.signal.throwIfAborted()
      check()
      if (JSON.stringify(request.scope) !== scopeKey || !isContract(contract, result))
        throw new Error('NATIVE_CODE_SERVICE_REPLY_UNCONFIRMED')
      return result as T
    } finally {
      pending.delete(cancel)
      signal?.removeEventListener('abort', abort)
    }
  }
  return {
    prepare: (payload: NativeCodeServicePreparePayload, operationId: string, signal?: AbortSignal) =>
      call<NativeCodeServiceRecord>('integrations/services/code/prepare', { ...payload }, 'NativeCodeServiceRecord', operationId, undefined, signal),
    read: (leaseId: string, signal?: AbortSignal) =>
      call<NativeCodeServiceReadResult>('integrations/services/code/read', { leaseId }, 'NativeCodeServiceReadResult', undefined, undefined, signal),
    start: (leaseId: string, revision: number, operationId: string, signal?: AbortSignal) =>
      call<NativeCodeServiceMutationResult>('integrations/services/code/start', { leaseId }, 'NativeCodeServiceMutationResult', operationId, revision, signal),
    revoke: (leaseId: string, revision: number, operationId: string, signal?: AbortSignal) =>
      call<NativeCodeServiceMutationResult>('integrations/services/code/revoke', { leaseId }, 'NativeCodeServiceMutationResult', operationId, revision, signal),
    close() { active = false; for (const request of pending) request.abort(); pending.clear() },
  }
}
