import { createRandomUuid } from '@/lib/random-id'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from './accountContextEvents'
import { integrationControlCapability } from '../../../shared/integrationControlMethods.mjs'
import {
  isIntegrationReply,
  isIntegrationScope,
  isTaskWorkspaceSnapshot,
} from '../../../shared/generated/contractGuards.mjs'
import type {
  IntegrationTaskCapabilityScopeControlTarget,
  IntegrationRequest,
  IntegrationScope,
  TaskWorkspaceReadParams,
  TaskWorkspaceSnapshot,
} from '../../../shared/generated/contracts'

export interface TaskWorkspaceTarget {
  serverId: string
  workspacePath?: string
}
export type TaskWorkspaceReadError =
  'cancelled' | 'scope_changed' | 'cursor_invalid' | 'unsupported' | 'invalid_reply' | 'unavailable'
export class TaskWorkspaceClientError extends Error {
  readonly code: TaskWorkspaceReadError
  constructor(code: TaskWorkspaceReadError) {
    super(code)
    this.code = code
  }
}
const METHOD = 'integrations/tasks/readWorkspace' as const
const CURSOR_ERRORS = new Set([
  'TASK_WORKSPACE_CURSOR_INVALID',
  'TASK_WORKSPACE_CURSOR_EXPIRED',
  'TASK_WORKSPACE_SOURCE_CHANGED',
])

/** A comparison fence, never a grant or a substitute for native authorization. */
function scopeKey(scope: IntegrationScope) {
  return JSON.stringify([
    scope.accountId,
    scope.organizationId ?? null,
    scope.targetId,
    scope.workspaceId,
    scope.identityGeneration,
    scope.targetRevision,
  ])
}
function errorFrom(error: unknown): TaskWorkspaceClientError {
  if (error instanceof TaskWorkspaceClientError) return error
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'INTEGRATION_TARGET_UPGRADE_REQUIRED' || code === 'INTEGRATION_METHOD_UNSUPPORTED')
    return new TaskWorkspaceClientError('unsupported')
  if (code === 'INTEGRATION_REPLY_INVALID' || code === 'INTEGRATION_REQUEST_INVALID')
    return new TaskWorkspaceClientError('invalid_reply')
  if (code === 'INTEGRATION_OWNER_CHANGED') return new TaskWorkspaceClientError('scope_changed')
  return new TaskWorkspaceClientError('unavailable')
}
function validatePage(
  value: unknown,
  scope: IntegrationScope,
  threadId: string,
  snapshotId?: string,
  sourceTarget?: IntegrationTaskCapabilityScopeControlTarget
): TaskWorkspaceSnapshot {
  if (
    !isTaskWorkspaceSnapshot(value) ||
    value.schemaVersion !== 1 ||
    value.thread.reference.kind !== 'thread' ||
    value.thread.reference.threadId !== threadId ||
    scopeKey(value.scope) !== scopeKey(scope) ||
    value.entries.length > 10 ||
    value.facets.length > 7 ||
    value.artifactRefs.length > 1024 ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 0
  )
    throw new TaskWorkspaceClientError('invalid_reply')
  const tuple = (target?: IntegrationTaskCapabilityScopeControlTarget | null) =>
    target
      ? JSON.stringify([
          target.initialAttempt.threadId,
          target.initialAttempt.turnId,
          target.initialAttempt.attemptId,
          target.runtimeOperationId ?? null,
        ])
      : null
  if (
    tuple(value.sourceTarget) !== tuple(sourceTarget) ||
    (!sourceTarget && (value.sourceSelection != null || value.runtime != null))
  )
    throw new TaskWorkspaceClientError('invalid_reply')
  if (snapshotId && value.snapshotId !== snapshotId)
    throw new TaskWorkspaceClientError('cursor_invalid')
  const kinds = new Set<string>()
  for (const facet of value.facets) {
    if (
      kinds.has(facet.kind) ||
      (facet.observedCount != null &&
        (!Number.isSafeInteger(facet.observedCount) || facet.observedCount < 0))
    )
      throw new TaskWorkspaceClientError('invalid_reply')
    kinds.add(facet.kind)
  }
  for (const entry of [value.thread, ...value.entries]) {
    const ref = entry.reference
    if (ref.threadId !== threadId || Array.from(entry.title).length > 512)
      throw new TaskWorkspaceClientError('invalid_reply')
    if (
      ref.kind === 'agent' &&
      ref.backgroundRun &&
      (ref.backgroundRun.agentId !== ref.agentId || ref.backgroundRun.parentSessionId !== threadId)
    )
      throw new TaskWorkspaceClientError('invalid_reply')
  }
  if (value.runtime && value.runtime.threadId !== threadId)
    throw new TaskWorkspaceClientError('invalid_reply')
  if (value.sourceSelection && value.sourceSelection.threadId !== threadId)
    throw new TaskWorkspaceClientError('invalid_reply')
  return value
}

/** Existing LocalExecutor/Gateway route only; it never creates, resumes or stops a task. */
export function createTaskWorkspaceTransport(
  target: TaskWorkspaceTarget,
  isCurrent: () => boolean
) {
  const ownedTarget = {
    serverId: target.serverId,
    ...(target.workspacePath !== undefined ? { workspacePath: target.workspacePath } : {}),
  }
  const accountCurrent = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  let nativeScope: IntegrationScope | undefined
  const check = () => {
    if (!active || !isCurrent() || !accountCurrent(ownedTarget.serverId))
      throw new TaskWorkspaceClientError('scope_changed')
  }
  return {
    async read(
      params: TaskWorkspaceReadParams,
      options: { signal?: AbortSignal; snapshotId?: string } = {}
    ): Promise<TaskWorkspaceSnapshot> {
      check()
      if (!ownedTarget.serverId || integrationControlCapability(METHOD) !== 'taskWorkspaceV1')
        throw new TaskWorkspaceClientError('unsupported')
      if (
        !/^[A-Za-z0-9_-]{1,256}$/.test(params.threadId) ||
        (params.cursor != null && (!params.cursor || params.cursor.length > 256))
      )
        throw new TaskWorkspaceClientError('unavailable')
      const payload = structuredClone(params)
      const cancel = new AbortController()
      const abort = () => cancel.abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) cancel.abort()
      pending.add(cancel)
      try {
        cancel.signal.throwIfAborted()
        if (!nativeScope) {
          const scope = await requestLocalExecutor<unknown>(
            'runtime.integrations.request',
            { ...ownedTarget, method: 'integrations/scope/read', params: {} },
            { signal: cancel.signal }
          )
          cancel.signal.throwIfAborted()
          check()
          if (!isIntegrationScope(scope)) throw new TaskWorkspaceClientError('invalid_reply')
          if (nativeScope && scopeKey(nativeScope) !== scopeKey(scope))
            throw new TaskWorkspaceClientError('scope_changed')
          nativeScope = structuredClone(scope)
        }
        const owner = structuredClone(nativeScope)
        const request: IntegrationRequest = {
          contractVersion: 'parallel-v1',
          requestId: createRandomUuid(),
          timeoutMs: 15000,
          scope: owner,
          payload,
        }
        const reply = await requestLocalExecutor<unknown>(
          'runtime.integrations.request',
          { ...ownedTarget, method: METHOD, params: request },
          { signal: cancel.signal }
        )
        cancel.signal.throwIfAborted()
        check()
        if (
          !isIntegrationReply(reply) ||
          reply.requestId !== request.requestId ||
          reply.operationId !== null
        )
          throw new TaskWorkspaceClientError('invalid_reply')
        if (reply.status !== 'completed') {
          if (reply.result !== null || !reply.error)
            throw new TaskWorkspaceClientError('invalid_reply')
          if (CURSOR_ERRORS.has(reply.error.code))
            throw new TaskWorkspaceClientError('cursor_invalid')
          if (reply.error.code === 'TASK_WORKSPACE_CANCELLED')
            throw new TaskWorkspaceClientError('cancelled')
          if (reply.error.code === 'TASK_WORKSPACE_OWNER_MISMATCH')
            throw new TaskWorkspaceClientError('scope_changed')
          throw new TaskWorkspaceClientError('unavailable')
        }
        if (reply.error !== null) throw new TaskWorkspaceClientError('invalid_reply')
        return structuredClone(
          validatePage(
            reply.result,
            owner,
            payload.threadId,
            options.snapshotId,
            payload.sourceTarget ?? undefined
          )
        )
      } catch (error) {
        if (cancel.signal.aborted) throw new TaskWorkspaceClientError('cancelled')
        check()
        throw errorFrom(error)
      } finally {
        pending.delete(cancel)
        options.signal?.removeEventListener('abort', abort)
      }
    },
    isCurrent() {
      return active && isCurrent() && accountCurrent(ownedTarget.serverId)
    },
    cancelPending() {
      for (const controller of pending) controller.abort()
    },
    dispose() {
      active = false
      for (const controller of pending) controller.abort()
      pending.clear()
    },
  }
}
export type TaskWorkspaceTransport = ReturnType<typeof createTaskWorkspaceTransport>
