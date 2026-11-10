import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { createRandomUuid } from '@/lib/random-id'
import { isContract } from '../../../../shared/generated/validator.mjs'
import { isRemoteOperationControlReply, isRemoteOperationListReply } from '../../../../shared/remotes/controlContracts.mjs'
import type { IntegrationScope } from '../../../../shared/generated/contracts.integrations-core'
import type { RemoteOperationControlMethod, RemoteOperationControlParams, RemoteOperationControlReply, RemoteOperationListReply } from '../../../../shared/generated/contracts.integrations-remotes'

export interface RemoteOperationTarget { serverId: string; workspacePath: string }
export interface RemoteOperationTransport {
  request(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
}
export class RemoteOperationClientError extends Error {
  readonly code: string
  readonly uncertain: boolean
  constructor(code: string, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain }
}
export function remoteScopeKey(scope: IntegrationScope): string {
  return JSON.stringify([scope.accountId, scope.targetId, scope.workspaceId, scope.identityGeneration, scope.targetRevision,
    scope.organizationId === undefined ? 'absent' : scope.organizationId])
}
/** One target and account epoch. A missing cancellation receipt is read back, never resent. */
export class RemoteOperationClient {
  private disposed = false
  private readonly pending = new Set<AbortController>()
  private readonly accountValid = captureAccountContextRevision()
  private scope?: IntegrationScope
  readonly target: Readonly<RemoteOperationTarget>
  private readonly transport: RemoteOperationTransport
  constructor(target: RemoteOperationTarget, transport: RemoteOperationTransport = { request: requestLocalExecutor }) {
    this.target = Object.freeze({ ...target }); this.transport = transport
  }
  dispose() { this.disposed = true; this.pending.forEach(abort => abort.abort()); this.pending.clear() }
  private check(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.disposed || !this.accountValid(this.target.serverId)) throw new RemoteOperationClientError('REMOTE_CONTROL_OWNER_CHANGED')
  }
  private async call(method: RemoteOperationControlMethod, operationId: string, expectedRevision: number | undefined, signal?: AbortSignal): Promise<RemoteOperationControlReply> {
    if (!operationId.trim() || operationId.length > 256) throw new RemoteOperationClientError('REMOTE_CONTROL_INVALID_OPERATION')
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) abort.abort()
    this.pending.add(abort)
    const cancellation = method === 'integrations/remotes/cancelOperation'
    let dispatched = false
    try {
      this.check(abort.signal)
      if (!this.scope) {
        const observed = await this.transport.request('runtime.integrations.request', { ...this.target, method: 'integrations/scope/read', params: {} }, { signal: abort.signal })
        this.check(abort.signal)
        if (!isContract('IntegrationScope', observed)) throw new RemoteOperationClientError('REMOTE_CONTROL_SCOPE_INVALID')
        this.scope = Object.freeze(structuredClone(observed as IntegrationScope))
      }
      const params: RemoteOperationControlParams = { requestId: createRandomUuid(), scope: this.scope, operationId, ...(expectedRevision === undefined ? {} : { expectedRevision }) }
      this.check(abort.signal)
      dispatched = cancellation
      const reply = await this.transport.request('runtime.integrations.request', { ...this.target, method, params }, { signal: abort.signal })
      this.check(abort.signal)
      if (!isRemoteOperationControlReply(reply) || reply.requestId !== params.requestId || reply.operationId !== operationId || remoteScopeKey(reply.scope) !== remoteScopeKey(this.scope))
        throw new RemoteOperationClientError('REMOTE_CONTROL_REPLY_INVALID', cancellation)
      return reply
    } catch (error) {
      if (error instanceof RemoteOperationClientError) throw error
      const code = error instanceof Error && error.message.includes('UPGRADE_REQUIRED') ? 'REMOTE_CONTROL_UPGRADE_REQUIRED'
        : this.disposed || abort.signal.aborted ? 'REMOTE_CONTROL_OWNER_CHANGED' : 'REMOTE_CONTROL_UNAVAILABLE'
      throw new RemoteOperationClientError(code, dispatched && code !== 'REMOTE_CONTROL_UPGRADE_REQUIRED')
    } finally {
      signal?.removeEventListener('abort', stop)
      this.pending.delete(abort)
    }
  }
  async recent(signal?: AbortSignal): Promise<RemoteOperationListReply> {
    const abort = new AbortController(); const stop = () => abort.abort()
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) abort.abort()
    this.pending.add(abort)
    try {
      this.check(abort.signal)
      if (!this.scope) {
        const observed = await this.transport.request('runtime.integrations.request', { ...this.target, method: 'integrations/scope/read', params: {} }, { signal: abort.signal })
        this.check(abort.signal)
        if (!isContract('IntegrationScope', observed)) throw new RemoteOperationClientError('REMOTE_CONTROL_SCOPE_INVALID')
        this.scope = Object.freeze(structuredClone(observed as IntegrationScope))
      }
      const params = { requestId: createRandomUuid(), scope: this.scope }
      const reply = await this.transport.request('runtime.integrations.request', { ...this.target, method: 'integrations/remotes/listOperations', params }, { signal: abort.signal })
      this.check(abort.signal)
      if (!isRemoteOperationListReply(reply) || reply.requestId !== params.requestId || remoteScopeKey(reply.scope) !== remoteScopeKey(this.scope) || reply.items.length > 10 || reply.total < reply.items.length)
        throw new RemoteOperationClientError('REMOTE_CONTROL_REPLY_INVALID')
      return reply
    } finally { signal?.removeEventListener('abort', stop); this.pending.delete(abort) }
  }
  read(operationId: string, signal?: AbortSignal) { return this.call('integrations/remotes/readOperation', operationId, undefined, signal) }
  cancel(operationId: string, expectedRevision: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) return Promise.reject(new RemoteOperationClientError('REMOTE_CONTROL_REVISION_REQUIRED'))
    return this.call('integrations/remotes/cancelOperation', operationId, expectedRevision, signal)
  }
}
