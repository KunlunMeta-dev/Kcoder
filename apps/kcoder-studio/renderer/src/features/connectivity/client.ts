import type {
  ConnectivityPort,
  ConnectivityMethod,
  ConnectivityReply,
  ConnectivityRequest,
  ConnectivityScope,
} from './types'
import { isIntegrationReply } from '../../../../shared/generated/contractGuards.mjs'
import { createRandomUuid } from '@/lib/random-id'
import { invalidateChannelBindings } from '@/kcoder/channelBindingEvents'

const mutations = new Set<ConnectivityMethod>([
  'prepareConnectionAction',
  'verifyCapability',
  'submitDelivery',
  'cancelDelivery',
  'reconcileDelivery',
])
export function connectivityScopeKey(scope: ConnectivityScope) {
  return JSON.stringify([
    scope.accountId,
    scope.targetId,
    scope.workspaceId,
    scope.identityGeneration,
    scope.targetRevision,
    scope.organizationId ?? null,
  ])
}
function canonicalIntent(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalIntent).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(
          key =>
            JSON.stringify(key) + ':' + canonicalIntent((value as Record<string, unknown>)[key])
        )
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
export class ConnectivityClientError extends Error {
  readonly code: string
  readonly recovery: string
  readonly operationId: string | null
  constructor(code: string, recovery: string, operationId: string | null = null) {
    super(code)
    this.code = code
    this.recovery = recovery
    this.operationId = operationId
  }
}
export class ConnectivityClient {
  private readonly pendingMutations = new Map<string, string>()
  private readonly getScope: () => ConnectivityScope
  private readonly transport: <T>(
    port: ConnectivityPort,
    method: ConnectivityMethod,
    request: ConnectivityRequest,
    signal?: AbortSignal
  ) => Promise<ConnectivityReply<T>>
  constructor(
    getScope: () => ConnectivityScope,
    transport: <T>(
      port: ConnectivityPort,
      method: ConnectivityMethod,
      request: ConnectivityRequest,
      signal?: AbortSignal
    ) => Promise<ConnectivityReply<T>>
  ) {
    this.getScope = getScope
    this.transport = transport
  }
  scopeIdentity() {
    return connectivityScopeKey(this.getScope())
  }
  async call<T>(
    port: ConnectivityPort,
    method: ConnectivityMethod,
    payload: Record<string, unknown>,
    options: {
      operationId?: string
      expectedRevision?: string
      expectedScopeKey?: string
      signal?: AbortSignal
    } = {}
  ): Promise<T> {
    const scope = this.getScope()
    const owner = connectivityScopeKey(scope)
    if (options.expectedScopeKey !== undefined && options.expectedScopeKey !== owner)
      throw new ConnectivityClientError('TARGET_CHANGED', 'repair_configuration')
    const intent = canonicalIntent([owner, port, method, payload, options.expectedRevision ?? null])
    let operationId = options.operationId ?? this.pendingMutations.get(intent)
    if (mutations.has(method) && !operationId) {
      if (this.pendingMutations.size >= 64)
        throw new ConnectivityClientError('PENDING_OPERATION_CAPACITY', 'reconcile_original')
      operationId = createRandomUuid()
    }
    if (mutations.has(method) && operationId) this.pendingMutations.set(intent, operationId)
    // Starting a Weixin channel can wait for an entire authenticated long poll.
    const needsStartupBudget =
      method === 'prepareConnectionAction' &&
      (payload.action === 'start' ||
        payload.action === 'takeoverBot' ||
        (payload.action === 'save' && !options.expectedRevision))
    const timeoutMs = needsStartupBudget ? 60_000 : 30_000
    const request: ConnectivityRequest = {
      contractVersion: 'parallel-v1',
      requestId: createRandomUuid(),
      scope,
      timeoutMs,
      payload,
      ...(operationId ? { operationId } : {}),
      ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
    }
    let response: ConnectivityReply<T>
    try {
      response = await this.transport<T>(port, method, request, options.signal)
    } catch {
      throw new ConnectivityClientError(
        'CONNECTION_REQUEST_UNCONFIRMED',
        mutations.has(method) ? 'reconcile_original' : 'retry_read',
        operationId ?? null
      )
    }
    if (connectivityScopeKey(this.getScope()) !== owner)
      throw new ConnectivityClientError('TARGET_CHANGED', 'repair_configuration')
    if (
      !isIntegrationReply(response) ||
      response.contractVersion !== 'parallel-v1' ||
      response.requestId !== request.requestId ||
      (mutations.has(method) && response.operationId !== request.operationId)
    )
      throw new ConnectivityClientError(
        'CONTRACT_UNSUPPORTED',
        'repair_configuration',
        operationId ?? null
      )
    if (response.status !== 'completed' && response.status !== 'accepted') {
      if (response.status === 'rejected' && response.error?.recovery === 'retry_read')
        this.pendingMutations.delete(intent)
      throw new ConnectivityClientError(
        response.error?.code ?? 'OPERATION_UNCONFIRMED',
        response.error?.recovery ?? 'reconcile_original',
        operationId ?? null
      )
    }
    if (response.result === null || response.error !== null)
      throw new ConnectivityClientError(
        'MISSING_PORT_RESULT',
        'reconcile_original',
        operationId ?? null
      )
    if (mutations.has(method)) this.pendingMutations.delete(intent)
    if (method === 'prepareConnectionAction' &&
      ['bindTask', 'switchTask', 'unbindTask'].includes(String(payload.action)))
      invalidateChannelBindings(owner)
    return response.result
  }
}
