import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import type { TaskWorkspaceTarget } from './taskWorkspaceTransport'
import {
  isIntegrationReply,
  isIntegrationScope,
  isIntegrationTaskCapabilityScopeDirectorySnapshot,
} from '../../../shared/generated/contractGuards.mjs'
import type {
  IntegrationRequest,
  IntegrationScope,
  IntegrationTaskCapabilityScopeDirectoryReadParams,
  IntegrationTaskCapabilityScopeDirectorySnapshot,
} from '../../../shared/generated/contracts'

/** Only observes saved identities. It cannot select sources or activate a task. */
export function createTaskCapabilityScopeDirectoryTransport(
  target: TaskWorkspaceTarget,
  current: () => boolean
) {
  const owner = { ...target }
  const account = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  const check = () => {
    if (!active || !current() || !account(owner.serverId))
      throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_OWNER_CHANGED')
  }
  return {
    async read(
      params: IntegrationTaskCapabilityScopeDirectoryReadParams,
      signal?: AbortSignal
    ): Promise<IntegrationTaskCapabilityScopeDirectorySnapshot> {
      check()
      const payload = structuredClone(params)
      const cancel = new AbortController()
      const abort = () => cancel.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) cancel.abort()
      pending.add(cancel)
      try {
        cancel.signal.throwIfAborted()
        const scope = await requestLocalExecutor<unknown>(
          'runtime.integrations.request',
          {
            ...owner,
            method: 'integrations/scope/read',
            params: {},
          },
          { signal: cancel.signal }
        )
        check()
        cancel.signal.throwIfAborted()
        if (!isIntegrationScope(scope)) throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
        const request: IntegrationRequest = {
          contractVersion: 'parallel-v1',
          requestId: createRandomUuid(),
          scope: structuredClone(scope) as IntegrationScope,
          timeoutMs: 15000,
          payload,
        }
        const response = await requestLocalExecutor<unknown>(
          'runtime.integrations.request',
          {
            ...owner,
            method: 'integrations/tasks/readSavedTaskSourceBindings',
            params: request,
          },
          { signal: cancel.signal }
        )
        check()
        cancel.signal.throwIfAborted()
        if (
          !isIntegrationReply(response) ||
          response.requestId !== request.requestId ||
          response.operationId !== null
        )
          throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
        if (response.status !== 'completed' || response.error !== null) {
          if (response.result !== null || !response.error)
            throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
          throw new Error(response.error.code)
        }
        const page = response.result
        if (!isIntegrationTaskCapabilityScopeDirectorySnapshot(page) || page.entries.length > 10)
          throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
        const seen = new Set<string>()
        for (const row of page.entries) {
          if (!row.referenceId || seen.has(row.referenceId) || row.referenceId.length > 256)
            throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
          seen.add(row.referenceId)
          if (
            row.target &&
            payload.threadId &&
            row.target.initialAttempt.threadId !== payload.threadId
          )
            throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
          if (
            row.target &&
            row.savedSnapshot &&
            row.target.initialAttempt.threadId !== row.savedSnapshot.threadId
          )
            throw new Error('TASK_CAPABILITY_SCOPE_DIRECTORY_INVALID_REPLY')
        }
        return structuredClone(page)
      } finally {
        pending.delete(cancel)
        signal?.removeEventListener('abort', abort)
      }
    },
    dispose() {
      active = false
      for (const cancel of pending) cancel.abort()
      pending.clear()
    },
  }
}
