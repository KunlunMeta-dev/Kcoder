import type { ResourceTarget } from '@/features/runtime-governance/resourceTransport'
import { createRandomUuid } from '@/lib/random-id'
import {
  ResourceController,
  ResourceClientError,
  type ResourceMutation,
} from '@/features/integration-resources/controller'
import type { AgentDefinitionItem, ResourceList } from '@/features/integration-resources/controller'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type {
  IntegrationRevisionRef,
  OfficeAssistantDefinition as AgentDefinition,
  OfficeAssistantDraft as AgentDefinitionDraft,
  OfficeExpertPackage,
  OfficeMarketExpert,
} from '../../../../shared/generated/contracts'

export function newExpert(language: string): AgentDefinition {
  return {
    schemaVersion: 1,
    id: `personal.${createRandomUuid()}`,
    scope: 'personal',
    title: '',
    description: '',
    language,
    instructions: '',
    inputSchema: { type: 'object' },
    capabilities: [],
    resources: [],
    modelSelection: { kind: 'inherit_current' },
    allowedTools: null,
    outputKinds: ['document'],
    acceptanceCriteria: [
      language === 'en' ? 'Review the result against the request' : '根据任务要求核对结果',
    ],
    externalSend: 'deny',
  }
}

/** Fresh Octop copies inherit task tools; existing definitions retain their policy. */
export function newExpertFromTemplate(template: AgentDefinition): AgentDefinition {
  return {
    ...structuredClone(template),
    id: `personal.${createRandomUuid()}`,
    scope: 'personal',
    allowedTools:
      template.id.startsWith('builtin.octop.') && template.allowedTools?.length === 0
        ? null
        : template.allowedTools,
  }
}

/** Stores only the original operation locator; definitions stay in the target resource store. */
export class ExpertClient {
  readonly pendingKey: string
  readonly controller: ResourceController
  readonly target?: ResourceTarget
  constructor(
    controller: ResourceController,
    target?: ResourceTarget
  ) {
    this.target = target
    this.controller = controller
    const scope = JSON.parse(controller.scopeKey())
    this.pendingKey = `kcoder.expert.pending:${JSON.stringify([scope.accountId, scope.targetId, scope.workspaceId])}`
  }
  pending(): string | null {
    return sessionStorage.getItem(this.pendingKey)
  }
  /** Remove only this client's matching locator; target history is unchanged. */
  acknowledgePending(operationId: string): boolean {
    if (this.pending() !== operationId) return false
    sessionStorage.removeItem(this.pendingKey)
    return true
  }
  list(cursor: string | undefined, language: string, signal: AbortSignal) {
    return this.controller.call<ResourceList<AgentDefinitionItem>>(
      'assistant/list',
      { limit: 10, language, personalOnly: true, ...(cursor ? { cursor } : {}) },
      undefined,
      signal
    )
  }
  market(
    query: string,
    scene: string,
    cursor: string | undefined,
    language: string,
    signal: AbortSignal
  ) {
    return this.controller.call<ResourceList<OfficeMarketExpert> & { scenes: string[] }>(
      'assistant/market/list',
      { query, scene, limit: 10, language, ...(cursor ? { cursor } : {}) },
      undefined,
      signal
    )
  }
  async mutate(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    revision?: number
  ) {
    if (this.pending()) throw new Error('OFFICE_OUTCOME_UNKNOWN')
    const operation: ResourceMutation = this.controller.operation()
    if (revision !== undefined) operation.expectedRevision = String(revision)
    sessionStorage.setItem(this.pendingKey, operation.operationId)
    try {
      const result = await this.controller.call(method, payload, operation, signal)
      this.acknowledgePending(operation.operationId)
      return result
    } catch (error) {
      if (error instanceof ResourceClientError && error.recovery !== 'reconcile_original')
        this.acknowledgePending(operation.operationId)
      throw error
    }
  }
  async reconcile(signal: AbortSignal) {
    const operationId = this.pending()
    if (!operationId) return
    const result = await this.controller.call(
      'agentDefinitions/operation/read',
      { operationId },
      undefined,
      signal
    )
    if (result.operationId !== operationId || result.phase !== 'completed')
      throw new Error('OFFICE_OUTCOME_UNKNOWN')
    this.acknowledgePending(operationId)
  }
  async save(
    definition: AgentDefinition,
    revision: number | undefined,
    signal: AbortSignal,
    copyFrom?: IntegrationRevisionRef
  ) {
    const result = await this.mutate(
      'assistant/saveDraft',
      { definition, ...(copyFrom ? { copyFrom } : {}) },
      signal,
      revision
    )
    if (!isContract('OfficeAssistantDraft', result.draft)) throw new Error('OFFICE_INVALID_REPLY')
    return result.draft as AgentDefinitionDraft
  }
  async package(id: string, signal: AbortSignal): Promise<OfficeExpertPackage | null> {
    const result = await this.controller.call('assistant/package/read', { id }, undefined, signal)
    if (result.package === null) return null
    if (!isContract('OfficeExpertPackage', result.package)) throw new Error('OFFICE_INVALID_REPLY')
    return result.package as OfficeExpertPackage
  }
}
