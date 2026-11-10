import { createRandomUuid } from '@/lib/random-id'
import {
  OfficeController,
  OfficeClientError,
  type OfficeAssistantItem,
  type OfficeList,
  type OfficeMutation,
} from '@/features/office-integration/controller'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type {
  IntegrationRevisionRef,
  OfficeAssistantDefinition,
  OfficeAssistantDraft,
  OfficeExpertPackage,
  OfficeMarketExpert,
} from '../../../../shared/generated/contracts'

export function newExpert(language: string): OfficeAssistantDefinition {
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
export function newExpertFromTemplate(
  template: OfficeAssistantDefinition
): OfficeAssistantDefinition {
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

/** Stores only the original operation locator; definitions and credentials stay on Native. */
export class ExpertClient {
  readonly pendingKey: string
  readonly controller: OfficeController
  readonly target?: { serverId: string; workspacePath?: string }
  constructor(controller: OfficeController, target?: { serverId: string; workspacePath?: string }) {
    this.target = target
    this.controller = controller
    const scope = JSON.parse(controller.scopeKey())
    this.pendingKey = `kcoder.expert.pending:${JSON.stringify([scope.accountId, scope.targetId, scope.workspaceId])}`
  }
  pending(): string | null {
    return sessionStorage.getItem(this.pendingKey)
  }
  list(cursor: string | undefined, language: string, signal: AbortSignal) {
    return this.controller.call<OfficeList<OfficeAssistantItem>>(
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
    return this.controller.call<OfficeList<OfficeMarketExpert> & { scenes: string[] }>(
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
    const operation: OfficeMutation = this.controller.operation()
    if (revision !== undefined) operation.expectedRevision = String(revision)
    sessionStorage.setItem(this.pendingKey, operation.operationId)
    try {
      const result = await this.controller.call(method, payload, operation, signal)
      sessionStorage.removeItem(this.pendingKey)
      return result
    } catch (error) {
      if (error instanceof OfficeClientError && error.recovery !== 'reconcile_original')
        sessionStorage.removeItem(this.pendingKey)
      throw error
    }
  }
  async reconcile(signal: AbortSignal) {
    const operationId = this.pending()
    if (!operationId) return
    const result = await this.controller.call(
      'office/readOperation',
      { operationId },
      undefined,
      signal
    )
    if (result.operationId !== operationId || result.phase !== 'completed')
      throw new Error('OFFICE_OUTCOME_UNKNOWN')
    sessionStorage.removeItem(this.pendingKey)
  }
  async save(
    definition: OfficeAssistantDefinition,
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
    return result.draft as OfficeAssistantDraft
  }
  async package(id: string, signal: AbortSignal): Promise<OfficeExpertPackage | null> {
    const result = await this.controller.call('assistant/package/read', { id }, undefined, signal)
    if (result.package === null) return null
    if (!isContract('OfficeExpertPackage', result.package)) throw new Error('OFFICE_INVALID_REPLY')
    return result.package as OfficeExpertPackage
  }
}
