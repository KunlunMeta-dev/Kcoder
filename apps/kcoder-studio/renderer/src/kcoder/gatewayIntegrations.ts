import {
  holdOfficeTaskNotifications,
  registerOfficeTask,
} from './gateway/runtime/officeTaskAdoption'
import {
  isRemoteOperationControlParams,
  isRemoteOperationControlReply,
  isRemoteOperationListParams,
  isRemoteOperationListReply,
} from '../../../shared/remotes/controlContracts.mjs'
import { isContract } from '../../../shared/generated/validator.mjs'
import { integrationControlCapability } from '../../../shared/integrationControlMethods.mjs'
import { captureAccountContextRevision } from './accountContextEvents'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { IntegrationReply } from '../../../shared/generated/contracts'

export class NativeIntegrationClientError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** Public control methods only. This route cannot invoke arbitrary private Ports. */
export async function requestNativeIntegration(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const method = text(params.method)
  const requiredCapability = params.requiredCapability
  if (
    requiredCapability !== undefined &&
    requiredCapability !== 'automationTaskModelsV1' &&
    requiredCapability !== 'automationPeriodBudgetsV1'
  )
    throw new NativeIntegrationClientError('INTEGRATION_REQUEST_INVALID')
  const scopeRead = method === 'integrations/scope/read'
  let capability = integrationControlCapability(method)
  if (!capability) throw new NativeIntegrationClientError('INTEGRATION_METHOD_UNSUPPORTED')
  const serverId = text(params.serverId)
  if (!serverId) throw new NativeIntegrationClientError('INTEGRATION_TARGET_REQUIRED')
  const workspacePath = text(params.workspacePath) ?? undefined
  const fields = structuredClone(record(params.params))
  if (
    method === 'integrations/artifact/acknowledgeExport' &&
    !Object.hasOwn(record(fields.payload), 'automationRunId')
  )
    capability = 'officeExportReceiptV1'

  // Optional JS fields are omitted on the actual JSON wire, never stringified.
  for (const key of ['operationId', 'expectedRevision', 'cancellationRef'])
    if (fields[key] === undefined) delete fields[key]
  const remoteControl = capability === 'remoteOperationControlV1'
  if (
    !(remoteControl
      ? method === 'integrations/remotes/listOperations'
        ? isRemoteOperationListParams(fields)
        : isRemoteOperationControlParams(fields)
      : isContract(scopeRead ? 'IntegrationScopeReadParams' : 'IntegrationRequest', fields))
  )
    throw new NativeIntegrationClientError('INTEGRATION_REQUEST_INVALID')
  const accountValid = captureAccountContextRevision()
  const generation = this.configurationEpochByTarget.get(serverId)
  const assertCurrent = () => {
    options?.signal?.throwIfAborted()
    if (
      this.disposed ||
      this.configurationEpochByTarget.get(serverId) !== generation ||
      !accountValid(serverId)
    )
      throw new NativeIntegrationClientError('INTEGRATION_OWNER_CHANGED')
  }
  assertCurrent()
  const target = await this.serverForParams({ deviceId: serverId })
  assertCurrent()
  const nativeManagementOnly = method?.startsWith('integrations/connectivity/') === true
  const client = await this.commandClient(target, workspacePath, nativeManagementOnly)
  assertCurrent()
  await this.assertCommandTarget(target)
  assertCurrent()
  if (
    client.supportsExperimental?.('integrationScopeV1') !== true ||
    client.supportsExperimental?.(capability) !== true ||
    (method === 'integrations/tasks/readWorkspace' &&
      record(fields.payload).sourceTarget != null &&
      client.supportsExperimental?.('taskWorkspaceSourcesV1') !== true)
  )
    throw new NativeIntegrationClientError('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  const explicitTaskModel =
    [
      'integrations/automation/previewSubscription',
      'integrations/automation/saveSubscription',
    ].includes(method ?? '') && record(record(fields.payload).draft).modelSelection != null
  if (
    (explicitTaskModel || requiredCapability === 'automationTaskModelsV1') &&
    client.supportsExperimental?.('automationTaskModelsV1') !== true
  )
    throw new NativeIntegrationClientError('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  const explicitPeriodBudget =
    [
      'integrations/automation/previewSubscription',
      'integrations/automation/saveSubscription',
    ].includes(method ?? '') && record(record(fields.payload).draft).periodBudget != null
  if (
    (explicitPeriodBudget || requiredCapability === 'automationPeriodBudgetsV1') &&
    client.supportsExperimental?.('automationPeriodBudgetsV1') !== true
  )
    throw new NativeIntegrationClientError('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  if (
    method === 'integrations/tasks/setTaskSources' &&
    Object.hasOwn(record(record(fields.payload).params), 'resourceBindings') &&
    client.supportsExperimental?.('taskResourceBindingsV1') !== true
  )
    throw new NativeIntegrationClientError('INTEGRATION_TARGET_UPGRADE_REQUIRED')
  assertCurrent()
  const officeAdoption =
    method === 'integrations/assistant/adopt' && record(fields.payload).startTask === true
  const releaseOfficeNotifications = officeAdoption
    ? holdOfficeTaskNotifications(this, client)
    : null
  try {
    const result = await client.request<unknown>(method!, fields, options)
    assertCurrent()
    await this.assertCommandTarget(target)
    assertCurrent()
    if (scopeRead) {
      if (!isContract('IntegrationScope', result))
        throw new NativeIntegrationClientError('INTEGRATION_REPLY_INVALID')
      return result
    }
    if (remoteControl && method === 'integrations/remotes/listOperations') {
      if (
        !isRemoteOperationListReply(result) ||
        result.requestId !== fields.requestId ||
        result.items.length > 10 ||
        result.total < result.items.length ||
        [
          'accountId',
          'targetId',
          'workspaceId',
          'identityGeneration',
          'targetRevision',
          'organizationId',
        ].some(
          key =>
            JSON.stringify(record(result.scope)[key]) !== JSON.stringify(record(fields.scope)[key])
        )
      )
        throw new NativeIntegrationClientError('INTEGRATION_REPLY_INVALID')
      return result
    }
    if (remoteControl) {
      if (
        !isRemoteOperationControlReply(result) ||
        result.requestId !== fields.requestId ||
        result.operationId !== fields.operationId ||
        [
          'accountId',
          'targetId',
          'workspaceId',
          'identityGeneration',
          'targetRevision',
          'organizationId',
        ].some(
          key =>
            JSON.stringify(record(result.scope)[key]) !== JSON.stringify(record(fields.scope)[key])
        )
      )
        throw new NativeIntegrationClientError('INTEGRATION_REPLY_INVALID')
      return result
    }
    if (!isContract('IntegrationReply', result))
      throw new NativeIntegrationClientError('INTEGRATION_REPLY_INVALID')
    const reply = result as IntegrationReply
    const successful = reply.status === 'accepted' || reply.status === 'completed'
    if (
      reply.requestId !== fields.requestId ||
      (fields.operationId && reply.operationId !== fields.operationId) ||
      (reply.status === 'accepted' && reply.operationId === null) ||
      (successful && reply.error !== null) ||
      (!successful && (reply.error === null || reply.result !== null))
    )
      throw new NativeIntegrationClientError('INTEGRATION_REPLY_INVALID')
    if (officeAdoption) registerOfficeTask(this, target, client, workspacePath, fields, reply)
    return reply
  } finally {
    releaseOfficeNotifications?.()
  }
}
