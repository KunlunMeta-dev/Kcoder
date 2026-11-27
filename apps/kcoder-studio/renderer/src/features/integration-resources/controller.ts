import type {
  IntegrationRequest,
  IntegrationScope,
  OfficeAssistantDefinition as AgentDefinition,
  OfficeResourceRef as AgentResourceRef,
} from '../../../../shared/generated/contracts.js'
import { isIntegrationReply } from '../../../../shared/generated/contractGuards.mjs'
export interface ResourceInputOptions {
  scope: IntegrationScope
  operationId: string
  signal: AbortSignal
  onProgress: (bytes: number) => void
}
export interface ResourceTransport {
  prepareInput?(file: File, options: ResourceInputOptions): Promise<unknown>
  call(
    method: string,
    request: IntegrationRequest,
    options: { signal?: AbortSignal }
  ): Promise<unknown>
}
export interface ResourceMutation {
  operationId: string
  expectedRevision?: string
}
export class ResourceClientError extends Error {
  readonly code: string
  readonly operationId?: string
  readonly recovery: string
  constructor(code: string, recovery: string, operationId?: string) {
    super(code)
    this.name = 'ResourceClientError'
    this.code = code
    this.recovery = recovery
    this.operationId = operationId
  }
}
const writes = new Set([
  'assistant/skills/install',
  'assistant/market/install',
  'assistant/deleteDraft',
  'assistant/saveDraft',
  'assistant/saveVersion',
  'assistant/adopt',
  'assistant/archive',
  'assistant/export',
  'assistant/import',
  'artifact/export',
  'artifact/verify',
  'artifact/prepareAction',
  'artifact/executeAction',
  'dataset/create',
  'dataset/export',
  'office/generate',
])
const reads = new Set([
  'agentDefinitions/operation/read',
  'assistant/skills/catalog',
  'assistant/market/read',
  'assistant/market/list',
  'assistant/package/read',
  'assistant/list',
  'assistant/read',
  'assistant/versions',
  'assistant/validate',
  'artifact/list',
  'artifact/read',
  'artifact/source',
  'artifact/verification',
  'dataset/schema',
  'dataset/page',
  'dataset/query',
  'office/readiness',
  'office/readOperation',
])
export class ResourceController<TTransport extends ResourceTransport = ResourceTransport> {
  protected readonly transport: TTransport
  protected readonly currentScope: () => IntegrationScope
  constructor(transport: TTransport, currentScope: () => IntegrationScope) {
    this.transport = transport
    this.currentScope = currentScope
  }
  scopeKey(): string {
    return JSON.stringify(this.currentScope())
  }
  operation(): ResourceMutation {
    return { operationId: `resource-${crypto.randomUUID()}` }
  }
  async call<T extends Record<string, unknown>>(
    method: string,
    payload: Record<string, unknown>,
    mutation?: ResourceMutation,
    signal?: AbortSignal
  ): Promise<T> {
    if ((!reads.has(method) && !writes.has(method)) || (writes.has(method) && !mutation))
      throw new ResourceClientError('OFFICE_INVALID_REQUEST', 'none')
    if (signal?.aborted) throw new ResourceClientError('OFFICE_CANCELLED', 'none')
    const scope = structuredClone(this.currentScope())
    const key = JSON.stringify(scope)
    const request: IntegrationRequest = {
      contractVersion: 'parallel-v1',
      requestId: `request-${crypto.randomUUID()}`,
      scope,
      timeoutMs:
        method.startsWith('assistant/market/') || method.startsWith('assistant/skills/')
          ? 60_000
          : 30_000,
      payload,
      ...(mutation
        ? {
            operationId: mutation.operationId,
            ...(mutation.expectedRevision ? { expectedRevision: mutation.expectedRevision } : {}),
          }
        : {}),
    }
    let reply: unknown
    try {
      reply = await this.transport.call(
        method === 'agentDefinitions/operation/read' ? method : `integrations/${method}`,
        request,
        { signal }
      )
    } catch (error) {
      if (error instanceof ResourceClientError) {
        // Read recovery is not evidence that a dispatched mutation was rejected.
        if (writes.has(method) && error.recovery === 'retry_read')
          throw new ResourceClientError(error.code, 'reconcile_original', mutation?.operationId)
        throw error
      }
      throw new ResourceClientError(
        writes.has(method)
          ? 'OFFICE_OUTCOME_UNKNOWN'
          : signal?.aborted
            ? 'OFFICE_CANCELLED'
            : 'OFFICE_UNAVAILABLE',
        writes.has(method) ? 'reconcile_original' : 'retry_read',
        mutation?.operationId
      )
    }
    if (signal?.aborted || key !== this.scopeKey())
      throw new ResourceClientError(
        signal?.aborted ? 'OFFICE_CANCELLED' : 'OFFICE_SCOPE_CHANGED',
        mutation ? 'reconcile_original' : 'retry_read',
        mutation?.operationId
      )
    if (
      !isIntegrationReply(reply) ||
      reply.requestId !== request.requestId ||
      reply.operationId !== (request.operationId ?? null)
    )
      throw new ResourceClientError(
        'OFFICE_INVALID_REPLY',
        mutation ? 'reconcile_original' : 'retry_read',
        mutation?.operationId
      )
    if (reply.status !== 'completed' && reply.status !== 'accepted')
      throw new ResourceClientError(
        reply.error?.code ?? 'OFFICE_OUTCOME_UNKNOWN',
        reply.status === 'unknown' && mutation
          ? 'reconcile_original'
          : (reply.error?.recovery ?? 'reconcile_original'),
        mutation?.operationId
      )
    if (reply.status === 'accepted' && method !== 'assistant/adopt')
      throw new ResourceClientError(
        'OFFICE_OPERATION_PENDING',
        'reconcile_original',
        mutation?.operationId
      )
    if (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result))
      throw new ResourceClientError(
        'OFFICE_INVALID_REPLY',
        mutation ? 'reconcile_original' : 'retry_read',
        mutation?.operationId
      )
    return reply.result as T
  }
}

export interface ResourceList<T> extends Record<string, unknown> {
  items: T[]
  total: number
  nextCursor: string | null
}
export interface AgentDefinitionItem {
  definition: AgentDefinition
  builtin: boolean
  version?: string
  draftRevision?: number
  organizationPublication?: AgentResourceRef
}
