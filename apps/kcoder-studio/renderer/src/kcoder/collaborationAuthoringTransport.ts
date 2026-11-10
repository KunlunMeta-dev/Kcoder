import { captureAccountContextRevision } from './accountContextEvents'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isWorkflowCollaborationCatalogResult } from '../../../shared/generated/contractGuards.mjs'
import type { WorkflowDefinition } from '@/features/workflows/workflowApi'
import type {
  WorkflowCollaborationCatalogResult,
  WorkflowCollaborationPlan,
} from '../../../shared/generated/contracts'
import type { TaskWorkspaceTarget } from './taskWorkspaceTransport'

export class CollaborationAuthoringError extends Error {
  readonly code: 'cancelled' | 'scope_changed' | 'unknown' | 'unavailable' | 'invalid_reply'
  constructor(code: CollaborationAuthoringError['code']) {
    super(code)
    this.code = code
  }
}
/** Nonexecuting finite workflow authoring only. Scope checks are not authority. */
export function createCollaborationAuthoringTransport(
  target: TaskWorkspaceTarget,
  current: () => boolean
) {
  const owner = { ...target }
  const account = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true
  const check = () => {
    if (!active || !current() || !account(owner.serverId))
      throw new CollaborationAuthoringError('scope_changed')
  }
  const request = async (
    method: string,
    params: Record<string, unknown>,
    mutation: boolean,
    signal?: AbortSignal
  ): Promise<unknown> => {
    check()
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) cancel.abort()
    pending.add(cancel)
    let sent = false
    try {
      cancel.signal.throwIfAborted()
      check()
      sent = true
      const value = await requestLocalExecutor<unknown>(
        'runtime.workflows.request',
        { ...owner, method, params },
        { signal: cancel.signal }
      )
      cancel.signal.throwIfAborted()
      check()
      return value
    } catch (error) {
      if (mutation && sent) throw new CollaborationAuthoringError('unknown')
      if (cancel.signal.aborted) throw new CollaborationAuthoringError('cancelled')
      if (error instanceof CollaborationAuthoringError) throw error
      check()
      throw new CollaborationAuthoringError('unavailable')
    } finally {
      pending.delete(cancel)
      signal?.removeEventListener('abort', abort)
    }
  }
  const definition = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CollaborationAuthoringError('invalid_reply')
    const original = value as Partial<WorkflowDefinition>
    if (
      typeof original.id !== 'string' ||
      !original.id ||
      original.id.length > 256 ||
      typeof original.title !== 'string' ||
      original.title.length > 512 ||
      typeof original.description !== 'string' ||
      !Number.isSafeInteger(original.revision) ||
      (original.revision ?? 0) < 1 ||
      !['draft', 'saved'].includes(original.status ?? '') ||
      !Array.isArray(original.nodes) ||
      original.nodes.length > 256 ||
      !Number.isSafeInteger(original.createdAtMs) ||
      !Number.isSafeInteger(original.updatedAtMs) ||
      (original.savedVersion != null &&
        (!Number.isSafeInteger(original.savedVersion) || original.savedVersion < 1))
    )
      throw new CollaborationAuthoringError('invalid_reply')
    // This surface reads definition identity/counts only. The original workflow
    // library and server remain responsible for the native node contracts.
    return original as WorkflowDefinition
  }
  return {
    async catalog(
      threadId: string | undefined,
      signal?: AbortSignal
    ): Promise<WorkflowCollaborationCatalogResult> {
      const result = await request(
        'workflow/collaboration/catalog',
        threadId ? { threadId } : {},
        false,
        signal
      )
      if (
        !isWorkflowCollaborationCatalogResult(result) ||
        result.schemaVersion !== 1 ||
        result.roles.length > 8 ||
        result.tools.length > 8 ||
        result.threadId !== (threadId ?? null) ||
        (!threadId && result.modelOrigin !== 'execution_parent') ||
        (Boolean(threadId) && result.modelOrigin === 'execution_parent')
      )
        throw new CollaborationAuthoringError('invalid_reply')
      if ((result.modelOrigin === 'thread_snapshot') !== Boolean(result.modelSnapshot))
        throw new CollaborationAuthoringError('invalid_reply')
      return result
    },
    async create(title: string, signal?: AbortSignal): Promise<WorkflowDefinition> {
      return definition(await request('workflow/create', { title, description: '' }, true, signal))
    },
    async apply(
      original: WorkflowDefinition,
      plan: WorkflowCollaborationPlan,
      signal?: AbortSignal
    ): Promise<WorkflowDefinition> {
      const result = definition(
        await request(
          'workflow/collaboration/apply',
          { id: original.id, expectedRevision: original.revision, plan },
          true,
          signal
        )
      )
      if (result.id !== original.id || result.revision <= original.revision)
        throw new CollaborationAuthoringError('invalid_reply')
      return result
    },
    async save(original: WorkflowDefinition, signal?: AbortSignal): Promise<WorkflowDefinition> {
      const result = definition(
        await request(
          'workflow/save',
          { id: original.id, expectedRevision: original.revision },
          true,
          signal
        )
      )
      if (result.id !== original.id || result.status !== 'saved' || !result.savedVersion)
        throw new CollaborationAuthoringError('invalid_reply')
      return result
    },
    async read(id: string, signal?: AbortSignal): Promise<WorkflowDefinition> {
      const result = definition(await request('workflow/read', { id }, false, signal))
      if (result.id !== id) throw new CollaborationAuthoringError('invalid_reply')
      return result
    },
    isCurrent() {
      return active && current() && account(owner.serverId)
    },
    dispose() {
      active = false
      for (const item of pending) item.abort()
      pending.clear()
    },
  }
}
export type CollaborationAuthoringTransport = ReturnType<
  typeof createCollaborationAuthoringTransport
>
