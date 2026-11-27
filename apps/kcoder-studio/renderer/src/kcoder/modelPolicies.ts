import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { isContract } from '../../../shared/generated/validator.mjs'
import type {
  IntegrationScope,
  IntegrationReply,
  IntegrationModelPolicyCatalog,
  IntegrationModelResolutionResult,
  IntegrationModelHealthReport,
  IntegrationModelUsageReport,
  IntegrationModelPolicySettingsSnapshot,
  IntegrationModelPolicySettingsSaveResult,
  IntegrationModelPolicyDefinition,
  IntegrationOperationReceipt,
} from '../../../shared/generated/contracts'

export interface ModelPolicyTarget {
  serverId: string
  workspacePath?: string
  requiredCapability?: 'automationTaskModelsV1'
}
export class ModelPolicyError extends Error {
  readonly code:
    'unavailable' | 'unsupported' | 'changed' | 'cancelled' | 'invalid' | 'unknown' | 'custom_file'
  readonly operationId?: string
  constructor(code: ModelPolicyError['code'], operationId?: string) {
    super(code)
    this.code = code
    this.operationId = operationId
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function semanticScope(scope: IntegrationScope) {
  return JSON.stringify([
    scope.accountId,
    scope.targetId,
    scope.workspaceId,
    scope.identityGeneration,
    scope.targetRevision,
    scope.organizationId ?? null,
  ])
}
function persistentOwner(scope: IntegrationScope) {
  return JSON.stringify([
    scope.accountId,
    scope.targetId,
    scope.workspaceId,
    scope.organizationId ?? null,
  ])
}
/** Every method stays on the existing finite LocalExecutor/Gateway/native route. */
export async function connectModelPolicies(
  target: ModelPolicyTarget,
  isCurrent: () => boolean,
  signal: AbortSignal
) {
  const account = captureAccountContextRevision()
  let active = true
  const pending = new Set<AbortController>()
  const check = () => {
    if (!active || !isCurrent() || !account(target.serverId)) throw new ModelPolicyError('changed')
  }
  check()
  signal.throwIfAborted()
  const scope = await requestLocalExecutor<unknown>(
    'runtime.integrations.request',
    { ...target, method: 'integrations/scope/read', params: {} },
    { signal }
  ).catch(error => {
    if (record(error).code === 'INTEGRATION_TARGET_UPGRADE_REQUIRED')
      throw new ModelPolicyError('unsupported')
    throw error
  })
  check()
  signal.throwIfAborted()
  if (!isContract('IntegrationScope', scope)) throw new ModelPolicyError('invalid')
  const owner = structuredClone(scope) as IntegrationScope
  const scopeKey = semanticScope(owner)
  const pendingKey = `kcoder:model-policy-save:${encodeURIComponent(JSON.stringify([target.serverId, persistentOwner(owner)]))}`
  const pendingOperation = () => {
    try {
      const value = sessionStorage.getItem(pendingKey)
      return value && value.length <= 256 ? value : null
    } catch {
      return null
    }
  }
  const remember = (operationId: string | null) => {
    try {
      if (operationId) sessionStorage.setItem(pendingKey, operationId)
      else sessionStorage.removeItem(pendingKey)
    } catch {
      /* The native ledger remains authoritative when browser storage is unavailable. */
    }
  }
  const request = async (
    method: string,
    payload: Record<string, unknown>,
    expected: string,
    signal: AbortSignal,
    mutation?: { operationId: string; expectedRevision: string }
  ): Promise<Record<string, unknown>> => {
    check()
    if (signal.aborted) throw new ModelPolicyError('cancelled')
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    signal.addEventListener('abort', abort, { once: true })
    pending.add(cancel)
    const requestId = `model-policy-${crypto.randomUUID()}`
    let sent = false
    try {
      check()
      cancel.signal.throwIfAborted()
      sent = true
      const reply = await requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        {
          ...target,
          method,
          params: {
            contractVersion: 'parallel-v1',
            requestId,
            scope: owner,
            timeoutMs: 10_000,
            payload,
            ...mutation,
          },
        },
        { signal: cancel.signal }
      )
      check()
      cancel.signal.throwIfAborted()
      if (!isContract('IntegrationReply', reply))
        throw new ModelPolicyError('invalid', mutation?.operationId)
      const envelope = reply as IntegrationReply
      if (
        envelope.requestId !== requestId ||
        (mutation && envelope.operationId !== mutation.operationId) ||
        envelope.status !== 'completed' ||
        envelope.error !== null ||
        !isContract(expected, envelope.result)
      )
        throw new ModelPolicyError(mutation ? 'unknown' : 'unavailable', mutation?.operationId)
      return structuredClone(envelope.result) as Record<string, unknown>
    } catch (error) {
      const code = record(error).code
      if (
        code === 'INTEGRATION_TARGET_UPGRADE_REQUIRED' ||
        code === 'INTEGRATION_METHOD_UNSUPPORTED'
      )
        throw new ModelPolicyError('unsupported')
      if (record(error).message === 'MODEL_POLICY_SETTINGS_CUSTOM_FILE_UNAVAILABLE')
        throw new ModelPolicyError('custom_file')
      if (error instanceof ModelPolicyError) {
        if (mutation && sent && error.code === 'changed')
          throw new ModelPolicyError('unknown', mutation.operationId)
        throw error
      }
      if (mutation && sent) throw new ModelPolicyError('unknown', mutation.operationId)
      if (cancel.signal.aborted) throw new ModelPolicyError('cancelled')
      throw new ModelPolicyError('unavailable')
    } finally {
      pending.delete(cancel)
      signal.removeEventListener('abort', abort)
    }
  }
  return {
    ownerKey: scopeKey,
    isCurrent() {
      try {
        check()
        return true
      } catch {
        return false
      }
    },
    pendingOperation,
    forgetPendingOperation() {
      remember(null)
    },
    dispose() {
      active = false
      for (const cancel of pending) cancel.abort()
      pending.clear()
    },
    async policies(signal: AbortSignal) {
      return (await request(
        'integrations/models/readPolicies',
        {},
        'IntegrationModelPolicyCatalog',
        signal
      )) as unknown as IntegrationModelPolicyCatalog
    },
    async preview(id: string, version: string, signal: AbortSignal) {
      const result = (await request(
        'integrations/models/resolveSelection',
        { selection: { kind: 'auto_policy', id, version } },
        'IntegrationModelResolutionResult',
        signal
      )) as unknown as IntegrationModelResolutionResult
      if (
        result.selectionKind !== 'auto_policy' ||
        result.policyRef?.id !== id ||
        result.policyRef?.version !== version ||
        result.budget.reservationState !== 'not_reserved'
      )
        throw new ModelPolicyError('invalid')
      return result
    },
    async health(id: string, version: string, signal: AbortSignal) {
      const result = (await request(
        'integrations/models/readHealth',
        { id, version },
        'IntegrationModelHealthReport',
        signal
      )) as unknown as IntegrationModelHealthReport
      if (result.policyRef.id !== id || result.policyRef.version !== version)
        throw new ModelPolicyError('invalid')
      return result
    },
    async usage(id: string, version: string, signal: AbortSignal) {
      const result = (await request(
        'integrations/models/readUsage',
        { id, version },
        'IntegrationModelUsageReport',
        signal
      )) as unknown as IntegrationModelUsageReport
      if (result.policyRef.id !== id || result.policyRef.version !== version)
        throw new ModelPolicyError('invalid')
      return result
    },
    async settings(signal: AbortSignal) {
      return (await request(
        'integrations/models/settings/read',
        {},
        'IntegrationModelPolicySettingsSnapshot',
        signal
      )) as unknown as IntegrationModelPolicySettingsSnapshot
    },
    async save(
      policies: IntegrationModelPolicyDefinition[],
      expectedRevision: string,
      operationId: string,
      signal: AbortSignal
    ) {
      remember(operationId)
      const result = (await request(
        'integrations/models/settings/save',
        { policies },
        'IntegrationModelPolicySettingsSaveResult',
        signal,
        { operationId, expectedRevision }
      )) as unknown as IntegrationModelPolicySettingsSaveResult
      if (
        result.operation.operationId !== operationId ||
        persistentOwner(result.operation.scope) !== persistentOwner(owner) ||
        result.operation.port !== 'model-policy-settings' ||
        result.operation.method !== 'savePolicies'
      )
        throw new ModelPolicyError('unknown', operationId)
      if (['completed', 'rejected', 'cancelled'].includes(result.operation.phase)) remember(null)
      return result
    },
    async operation(
      operationId: string,
      signal: AbortSignal
    ): Promise<IntegrationOperationReceipt | null> {
      const value = await request(
        'integrations/models/settings/readOperation',
        { operationId },
        'IntegrationOperationReadResult',
        signal
      )
      const result = value.receipt
      if (result === null) return null
      if (!isContract('IntegrationOperationReceipt', result)) throw new ModelPolicyError('invalid')
      const receipt = result as IntegrationOperationReceipt
      if (
        receipt.operationId !== operationId ||
        persistentOwner(receipt.scope) !== persistentOwner(owner) ||
        receipt.port !== 'model-policy-settings' ||
        receipt.method !== 'savePolicies'
      )
        throw new ModelPolicyError('invalid')
      return receipt
    },
  }
}
export type ModelPolicyClient = Awaited<ReturnType<typeof connectModelPolicies>>
