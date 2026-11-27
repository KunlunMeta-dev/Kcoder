import type { WorkflowCreationLocator } from '@/kcoder/automationCreationPending'
import { sameKnowledgeOwner } from '@/features/knowledge-integration/identity'
import { requestLocalExecutor } from '@/host/localExecutor'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'
import { createRandomUuid } from '@/lib/random-id'
import {
  isIntegrationScope,
  isKnowledgeSettingsReadResult,
} from '../../../../shared/generated/contractGuards.mjs'
import {
  KnowledgeIntegrationClient,
  KnowledgeOperationError,
  type AutomationTaskDraft,
} from '@/features/knowledge-integration/client'
import { nativeKnowledgeTransport } from '@/features/runtime-governance/knowledgeTransport'
import { argumentFields, defaultArguments } from '@/features/workflows/workflowInputArguments'
import type { WorkflowDefinition } from '@/features/workflows/workflowApi'
import type { AutomationProjectAddress, ScheduledJob } from '@/kcoder/gatewayAutomationApi'

export interface ScheduledWorkflowChoice {
  id: string
  version: number
  title: string
  definition: WorkflowDefinition
  isCurrent: () => boolean
}

/** Explicit Create authorizes setup and one saved-version schedule, never an automatic retry. */
export async function createScheduledWorkflowTask({
  address,
  workflow,
  title,
  schedule,
  isCurrent,
  onPrepared,
}: {
  address: AutomationProjectAddress
  workflow: ScheduledWorkflowChoice
  title: string
  schedule: ScheduledJob['schedule']
  timezone: string
  isCurrent: () => boolean
  onPrepared: (locator: WorkflowCreationLocator) => void
}) {
  const check = () => {
    if (!isCurrent() || !workflow.isCurrent())
      throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  const target = { serverId: address.deviceId, workspacePath: address.workspacePath }
  check()
  let settings = await requestLocalExecutor<unknown>('runtime.settings.request', {
    ...target,
    method: 'settings/integrations/knowledge/read',
    params: {},
  })
  check()
  if (!isKnowledgeSettingsReadResult(settings))
    throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
  if (!settings.effective.businessAutomationEnabled) {
    settings = await requestLocalExecutor('runtime.settings.request', {
      ...target,
      method: 'settings/integrations/knowledge/save',
      params: { feature: 'subscriptions', enabled: true, expectedRevision: settings.revision },
    })
    check()
    if (!isKnowledgeSettingsReadResult(settings))
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
  }
  if (!settings.effective.businessAutomationEnabled)
    throw new KnowledgeOperationError('KNOWLEDGE_FEATURE_DISABLED')
  if (settings.restartRequired) {
    const applied = await requestLocalExecutor<{
      restarted?: boolean
      requiresConfirmation?: boolean
    }>(KCODER_RUNTIME_METHODS.appServerRestart, { serverId: address.deviceId, ifIdle: true })
    check()
    if (!applied.restarted || applied.requiresConfirmation)
      throw new KnowledgeOperationError('KNOWLEDGE_SETUP_BUSY')
  }
  const scope = await readWorkflowScope(address, check)
  const client = new KnowledgeIntegrationClient(scope, nativeKnowledgeTransport(target))
  try {
    const draft: AutomationTaskDraft = {
      id: createRandomUuid(),
      title: title.trim() || workflow.title,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      inputs: JSON.parse(defaultArguments(argumentFields(workflow.definition.inputSchema))),
      schedule,
      eventSource: null,
      maximumTokens: 1_000_000,
      maximumRuntimeSeconds: 300,
      delivery: { kind: 'studio' },
    }
    await client.previewSubscription(draft)
    check()
    const operationId = createRandomUuid()
    const { accountId, targetId, workspaceId, organizationId } = scope
    onPrepared({
      kind: 'workflow',
      operationId,
      subscriptionId: draft.id,
      owner: { accountId, targetId, workspaceId, organizationId },
    })
    check()
    return await client.saveSubscription(draft, 0, operationId)
  } finally {
    client.dispose()
  }
}

async function readWorkflowScope(address: AutomationProjectAddress, check: () => void) {
  check()
  const scope = await requestLocalExecutor<unknown>('runtime.integrations.request', {
    serverId: address.deviceId,
    workspacePath: address.workspacePath,
    method: 'integrations/scope/read',
    params: {},
  })
  check()
  if (!isIntegrationScope(scope)) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
  return scope
}

/** Read the saved subscription in its own domain; absence never authorizes replay. */
export async function readScheduledWorkflowCreation(
  address: AutomationProjectAddress,
  locator: WorkflowCreationLocator,
  isCurrent: () => boolean
): Promise<boolean> {
  const check = () => {
    if (!isCurrent()) throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  const scope = await readWorkflowScope(address, check)
  if (!sameKnowledgeOwner(locator.owner, scope))
    throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  const client = new KnowledgeIntegrationClient(
    scope,
    nativeKnowledgeTransport({
      serverId: address.deviceId,
      workspacePath: address.workspacePath,
    })
  )
  try {
    let after: string | undefined
    const seen = new Set<string>()
    do {
      const page = await client.listSubscriptions(after)
      check()
      const subscription = page.items.find(item => item.draft.id === locator.subscriptionId)
      if (subscription)
        return (
          subscription.consentRef === locator.operationId &&
          sameKnowledgeOwner(subscription.owner, locator.owner)
        )
      if (!page.nextCursor) return false
      if (seen.has(page.nextCursor)) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
      seen.add(page.nextCursor)
      after = page.nextCursor
    } while (after)
    return false
  } finally {
    client.dispose()
  }
}
