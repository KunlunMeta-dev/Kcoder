import { isDeliveryConnectionPage, isDeliveryDestinationPage } from './automationDeliveryInputs'
import { createRandomUuid } from '@/lib/random-id'
import { sameKnowledgeOwner } from './identity'
import type {
  AutomationPeriodBudget,
  AutomationPeriodBudgetPreview,
  AutomationRun,
  IntegrationEntityRef,
  AutomationApplicationSelectionParams,
  IntegrationTaskCapabilitySourceDescriptor,
  IntegrationTaskCapabilitySourceChoice,
  AutomationFileSelectionParams,
  AutomationFileSelectionReceipt,
  AutomationSubscription,
  AutomationSubscriptionDraft,
  KnowledgeAdoption,
  KnowledgeAdoptParams,
  AutomationTemplate,
  IntegrationPort,
  IntegrationReply,
  IntegrationRequest,
  IntegrationScope,
  IntegrationModelSelectionIntent,
  KnowledgePublication,
  KnowledgePublicationSummary,
  KnowledgeRetrieval,
  KnowledgeSourceObservation,
  MemoryProposal,
  MemoryReview,
  PublicationDraft,
  ReviewedMemory,
} from '../../../../shared/generated/contracts'
import {
  isIntegrationReply,
  isIntegrationEntityRef,
  isAutomationApplicationSelectionParams,
  isAutomationApplicationSelectionReceipt,
  isIntegrationTaskCapabilitySourceDescriptor,
  isAutomationFileSelectionParams,
  isAutomationFileSelectionReceipt,
  isKnowledgeAdoptionListResult,
  isKnowledgeAdoptionResult,
  isAutomationTemplateListResult,
  isAutomationClaimListResult,
  isAutomationQuarantineListResult,
  isAutomationConnectionEventSourceListResult,
  isMemoryTaskSnapshot,
  isIntegrationOperationReceipt,
  isMemoryListResult,
  isMemoryReadResult,
  isPublicationListResult,
  isPublicationReadResult,
  isPublicationHistoryListResult,
  isAutomationPeriodBudgetPreview,
  isPublicationSourcesReadResult,
  isKnowledgeRetrieveResult,
  isSubscriptionListResult,
  isSubscriptionReadResult,
  isIntegrationModelSelectionIntent,
  isAutomationRunListResult,
  isAutomationRunReadResult,
} from '../../../../shared/generated/contractGuards.mjs'

type Page<T> = { items: T[]; nextCursor?: string | null }
export type AutomationTaskDraft = AutomationSubscriptionDraft & {
  modelSelection?: IntegrationModelSelectionIntent
}
function modelSelectionKey(value: unknown) {
  if (value == null) return undefined
  return isIntegrationModelSelectionIntent(value)
    ? JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : null
}
function periodBudgetKey(value: AutomationPeriodBudget | null | undefined) {
  return value
    ? JSON.stringify([value.windowSeconds, value.maximumTokens, value.maximumModelCalls])
    : undefined
}
export interface SelectedAutomationApplicationSource {
  sourceRef: string
  selectionRevision: string
  owner: KnowledgeIntegrationClient
}
export interface SelectedAutomationFiles {
  sourceRef: string
  selectionRevision: string
  fileNames: string[]
}
export interface KnowledgeIntegrationTransport {
  call(
    port: IntegrationPort,
    method: string,
    request: IntegrationRequest,
    signal: AbortSignal
  ): Promise<unknown>
  management(
    domain: 'memory' | 'knowledge' | 'automation',
    method: string,
    request: IntegrationRequest,
    signal: AbortSignal
  ): Promise<unknown>
}
// Only fixed transport codes cross into presentation; arbitrary messages remain private.
function safeTransportCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'KNOWLEDGE_OPERATION_UNAVAILABLE'
  const value = error as { code?: unknown; reason?: unknown }
  if (
    typeof value.code === 'string' &&
    [
      'INTEGRATION_TARGET_UPGRADE_REQUIRED',
      'INTEGRATION_OWNER_CHANGED',
      'INTEGRATION_TARGET_REQUIRED',
      'KNOWLEDGE_POLICY_UNAVAILABLE',
    ].includes(value.code)
  )
    return value.code
  if (value.reason === 'unauthorized') return 'KNOWLEDGE_AUTHENTICATION_REQUIRED'
  if (value.reason === 'connection' || value.reason === 'timeout')
    return 'KNOWLEDGE_CONNECTION_UNAVAILABLE'
  return 'KNOWLEDGE_OPERATION_UNAVAILABLE'
}

export class KnowledgeOperationError extends Error {
  readonly code: string
  readonly operationId?: string
  readonly uncertain: boolean
  constructor(code: string, operationId?: string, uncertain = false) {
    super('Knowledge operation did not produce a confirmed result')
    this.code = code
    this.operationId = operationId
    this.uncertain = uncertain
  }
}
/** A target/identity-owned client. It never grants permission or retries mutations. */
export class KnowledgeIntegrationClient {
  readonly ownerKey: string
  readonly scope: IntegrationScope
  private readonly transport: KnowledgeIntegrationTransport
  private disposed = false
  private readonly pending = new Set<AbortController>()
  private readonly applicationSelections = new Map<string, AutomationApplicationSelectionParams>()
  private readonly fileSelections = new Map<string, AutomationFileSelectionParams>()
  constructor(scope: IntegrationScope, transport: KnowledgeIntegrationTransport) {
    this.scope = Object.freeze(structuredClone(scope))
    this.ownerKey = JSON.stringify(this.scope)
    this.transport = transport
  }
  dispose() {
    this.disposed = true
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
    this.fileSelections.clear()
    this.applicationSelections.clear()
  }
  private async invoke<T>(
    port: IntegrationPort,
    method: string,
    payload: Record<string, unknown>,
    guard: (value: unknown) => value is T,
    options: {
      mutation?: boolean
      operationId?: string
      completedOnly?: boolean
      unconfirmedCode?: string
      revision?: number
      management?: 'memory' | 'knowledge' | 'automation'
    } = {},
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
    const operationId = options.mutation ? (options.operationId ?? createRandomUuid()) : undefined
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.pending.add(controller)
    const request: IntegrationRequest = {
      contractVersion: 'parallel-v1',
      requestId: createRandomUuid(),
      scope: structuredClone(this.scope),
      operationId,
      expectedRevision: options.revision?.toString(),
      timeoutMs: 30_000,
      payload,
    }
    try {
      const raw = options.management
        ? await this.transport.management(options.management, method, request, controller.signal)
        : await this.transport.call(port, method, request, controller.signal)
      if (this.disposed || controller.signal.aborted)
        throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED', operationId, !!operationId)
      if (
        !isIntegrationReply(raw) ||
        raw.requestId !== request.requestId ||
        (operationId && raw.operationId !== operationId)
      ) {
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, !!operationId)
      }
      const reply: IntegrationReply = raw
      if (reply.status !== 'completed' && reply.status !== 'accepted') {
        throw new KnowledgeOperationError(
          reply.error?.code ?? 'KNOWLEDGE_OPERATION_UNAVAILABLE',
          operationId,
          reply.status === 'unknown'
        )
      }
      if (options.completedOnly && reply.status !== 'completed')
        throw new KnowledgeOperationError(
          options.unconfirmedCode ?? 'AUTOMATION_FILE_SELECTION_UNCONFIRMED',
          operationId,
          true
        )
      if (!guard(reply.result))
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, !!operationId)
      return reply.result
    } catch (error) {
      if (error instanceof KnowledgeOperationError) throw error
      // Transport text may contain private paths or provider secrets. Never surface it in UI.
      throw new KnowledgeOperationError(safeTransportCode(error), operationId, !!operationId)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.pending.delete(controller)
    }
  }
  async inspectOperation(operationId: string, signal?: AbortSignal) {
    return this.invoke(
      'P-RUNTIME',
      'readOperation',
      { operationId },
      (
        value
      ): value is {
        receipt: import('../../../../shared/generated/contracts').IntegrationOperationReceipt
      } => {
        return (
          !!value &&
          typeof value === 'object' &&
          'receipt' in value &&
          isIntegrationOperationReceipt(value.receipt)
        )
      },
      {},
      signal
    )
  }
  pendingFileSelection() {
    const first = this.fileSelections.entries().next().value
    return first ? { operationId: first[0], params: structuredClone(first[1]) } : undefined
  }
  async selectFileEventSource(
    params: AutomationFileSelectionParams,
    signal?: AbortSignal
  ): Promise<AutomationFileSelectionReceipt> {
    if (!isAutomationFileSelectionParams(params))
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_PAYLOAD')
    const pending = this.pendingFileSelection()
    if (pending)
      throw new KnowledgeOperationError(
        'AUTOMATION_FILE_SELECTION_UNCONFIRMED',
        pending.operationId,
        true
      )
    const operationId = createRandomUuid()
    const selector = structuredClone(params)
    this.fileSelections.set(operationId, selector)
    try {
      const receipt = await this.invoke(
        'P-AUTOMATION',
        'selectFileEventSource',
        { ...selector, fileNames: [...selector.fileNames] },
        isAutomationFileSelectionReceipt,
        { mutation: true, operationId, completedOnly: true, management: 'automation' },
        signal
      )
      const names = new Set(selector.fileNames)
      if (
        !sameKnowledgeOwner(receipt.owner, this.scope) ||
        !receipt.sourceRef ||
        !receipt.selectionRevision ||
        receipt.items.length !== names.size ||
        receipt.items.some(
          item => !names.delete(item.name) || !item.identityRevision || !item.resourceRef
        )
      )
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
      this.fileSelections.delete(operationId)
      return receipt
    } catch (error) {
      if (error instanceof KnowledgeOperationError && !error.uncertain)
        this.fileSelections.delete(operationId)
      throw error
    }
  }
  async reconcileFileEventSelection(
    operationId: string,
    signal?: AbortSignal
  ): Promise<{
    phase: import('../../../../shared/generated/contracts').IntegrationOperationPhase
    selection?: SelectedAutomationFiles
  }> {
    const original = this.fileSelections.get(operationId)
    if (!original) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    const { receipt } = await this.inspectOperation(operationId, signal)
    if (
      receipt.operationId !== operationId ||
      receipt.port !== 'P-AUTOMATION' ||
      receipt.method !== 'selectFileEventSource' ||
      !sameKnowledgeOwner(receipt.scope, this.scope) ||
      receipt.scope.identityGeneration !== this.scope.identityGeneration ||
      receipt.scope.targetRevision !== this.scope.targetRevision
    )
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
    if (receipt.phase === 'completed') {
      const reference = receipt.entityRef
      if (reference?.kind !== 'input' || !reference.id || !reference.revision)
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
      this.fileSelections.delete(operationId)
      return {
        phase: receipt.phase,
        selection: {
          sourceRef: reference.id,
          selectionRevision: reference.revision,
          fileNames: [...original.fileNames],
        },
      }
    }
    if (receipt.phase === 'rejected' || receipt.phase === 'cancelled')
      this.fileSelections.delete(operationId)
    return { phase: receipt.phase }
  }
  async listMemories(after?: string, signal?: AbortSignal): Promise<Page<ReviewedMemory>> {
    return (
      await this.invoke(
        'P-MEMORY',
        'listMemories',
        { after, includeCandidates: true },
        isMemoryListResult,
        {},
        signal
      )
    ).page
  }
  async proposeMemory(proposal: MemoryProposal) {
    return (
      await this.invoke('P-MEMORY', 'proposeMemory', { proposal }, isMemoryReadResult, {
        mutation: true,
      })
    ).memory
  }
  async reviewMemory(memory: ReviewedMemory, review: MemoryReview) {
    return (
      await this.invoke(
        'P-MEMORY',
        'reviewMemory',
        { memoryId: memory.id, review },
        isMemoryReadResult,
        { mutation: true, revision: memory.revision }
      )
    ).memory
  }
  async setMemoryEnabled(memory: ReviewedMemory, enabled: boolean) {
    return (
      await this.invoke(
        'P-MEMORY',
        'setMemoryEnabled',
        { memoryId: memory.id, enabled },
        isMemoryReadResult,
        { mutation: true, revision: memory.revision }
      )
    ).memory
  }
  async editMemory(memory: ReviewedMemory, content: string) {
    return (
      await this.invoke(
        'P-MEMORY',
        'editMemory',
        { memoryId: memory.id, content },
        isMemoryReadResult,
        { mutation: true, revision: memory.revision, management: 'memory' }
      )
    ).memory
  }
  async removeMemory(memory: ReviewedMemory) {
    return (
      await this.invoke('P-MEMORY', 'removeMemory', { memoryId: memory.id }, isMemoryReadResult, {
        mutation: true,
        revision: memory.revision,
        management: 'memory',
      })
    ).memory
  }
  async readMemoryTaskSnapshot(taskId: string, signal?: AbortSignal, threadId?: string) {
    const result = await this.invoke(
      'P-MEMORY',
      'readMemoryTaskSnapshot',
      { taskId, ...(threadId ? { threadId } : {}) },
      (
        value
      ): value is {
        snapshot: import('../../../../shared/generated/contracts').MemoryTaskSnapshot | null
      } =>
        !!value &&
        typeof value === 'object' &&
        'snapshot' in value &&
        (value.snapshot === null || isMemoryTaskSnapshot(value.snapshot)),
      { management: 'memory' },
      signal
    )
    if (
      result.snapshot &&
      (result.snapshot.taskId !== taskId ||
        !sameKnowledgeOwner(result.snapshot.owner, this.scope) ||
        result.snapshot.memories.some(memory => !sameKnowledgeOwner(memory.owner, this.scope)))
    )
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    return result
  }
  async listPublications(
    after?: string,
    signal?: AbortSignal
  ): Promise<Page<KnowledgePublication>> {
    return (
      await this.invoke(
        'P-KNOWLEDGE',
        'listPublications',
        { after },
        isPublicationListResult,
        { management: 'knowledge' },
        signal
      )
    ).page
  }
  async listPublicationHistory(
    after?: string,
    signal?: AbortSignal
  ): Promise<Page<KnowledgePublicationSummary>> {
    return (
      await this.invoke(
        'P-KNOWLEDGE',
        'listPublicationHistory',
        { after },
        isPublicationHistoryListResult,
        { management: 'knowledge' },
        signal
      )
    ).page
  }
  async resolvePublication(
    publication: Pick<KnowledgePublication, 'owner'> & {
      draft: Pick<PublicationDraft, 'publicationId'>
    },
    version: number,
    signal?: AbortSignal
  ) {
    const resolved = (
      await this.invoke(
        'P-KNOWLEDGE',
        'resolvePublication',
        { owner: publication.owner, publicationId: publication.draft.publicationId, version },
        isPublicationReadResult,
        {},
        signal
      )
    ).publication
    if (
      resolved.version !== version ||
      resolved.draft.publicationId !== publication.draft.publicationId ||
      !sameKnowledgeOwner(resolved.owner, publication.owner)
    )
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    return resolved
  }
  async readPublicationSources(
    publication: Pick<KnowledgePublication, 'owner' | 'version' | 'draft'>,
    after?: string,
    signal?: AbortSignal
  ): Promise<Page<KnowledgeSourceObservation>> {
    const result = await this.invoke(
      'P-KNOWLEDGE',
      'readPublicationSources',
      {
        owner: publication.owner,
        publicationId: publication.draft.publicationId,
        version: publication.version,
        after,
      },
      isPublicationSourcesReadResult,
      { management: 'knowledge' },
      signal
    )
    const key = (source: PublicationDraft['sources'][number]) =>
      JSON.stringify([source.libraryId, source.pageId, source.pageRevision])
    const sources = new Set(publication.draft.sources.map(key))
    if (result.page.items.some(item => !sources.has(key(item.source))))
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    return result.page
  }
  async adoptPublication(publication: KnowledgePublication, revision = 0) {
    return this.adoptPublicationReference(
      {
        owner: publication.owner,
        publicationId: publication.draft.publicationId,
        version: publication.version,
      },
      revision
    )
  }
  async adoptPublicationReference(reference: KnowledgeAdoptParams, revision = 0) {
    const adoption = (
      await this.invoke('P-KNOWLEDGE', 'adoptPublication', reference, isKnowledgeAdoptionResult, {
        mutation: true,
        revision,
        management: 'knowledge',
      })
    ).adoption
    if (
      !sameKnowledgeOwner(adoption.owner, this.scope) ||
      !sameKnowledgeOwner(adoption.publicationOwner, reference.owner) ||
      adoption.publicationId !== reference.publicationId ||
      adoption.publicationVersion !== reference.version
    )
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    return adoption
  }
  async listAdoptions(after?: string, signal?: AbortSignal): Promise<Page<KnowledgeAdoption>> {
    return (
      await this.invoke(
        'P-KNOWLEDGE',
        'listAdoptions',
        { after },
        isKnowledgeAdoptionListResult,
        { management: 'knowledge' },
        signal
      )
    ).page
  }
  async setAdoptionEnabled(adoption: KnowledgeAdoption, enabled: boolean) {
    if (!sameKnowledgeOwner(adoption.owner, this.scope))
      throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
    return (
      await this.invoke(
        'P-KNOWLEDGE',
        'setAdoptionEnabled',
        { adoptionId: adoption.id, enabled },
        isKnowledgeAdoptionResult,
        { mutation: true, revision: adoption.revision, management: 'knowledge' }
      )
    ).adoption
  }
  async listTemplates(locale: string, signal?: AbortSignal): Promise<AutomationTemplate[]> {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'listTemplates',
        { locale },
        isAutomationTemplateListResult,
        { management: 'automation' },
        signal
      )
    ).templates
  }
  async listArtifactClaims(runId: string, after?: string, signal?: AbortSignal) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'readAutomationClaims',
        { id: runId, after },
        isAutomationClaimListResult,
        { management: 'automation' },
        signal
      )
    ).page
  }
  async readRunArtifacts(runId: string, signal?: AbortSignal): Promise<IntegrationEntityRef[]> {
    const guard = (value: unknown): value is { artifactRefs: IntegrationEntityRef[] } => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const refs = (value as { artifactRefs?: unknown }).artifactRefs
      return Array.isArray(refs) && refs.length <= 1024 && refs.every(isIntegrationEntityRef)
    }
    return (
      await this.invoke(
        'P-AUTOMATION',
        'readAutomationArtifacts',
        { id: runId },
        guard,
        { management: 'automation' },
        signal
      )
    ).artifactRefs
  }
  async publishKnowledge(draft: PublicationDraft, version = 0) {
    return (
      await this.invoke('P-KNOWLEDGE', 'publishKnowledge', { draft }, isPublicationReadResult, {
        mutation: true,
        revision: version,
      })
    ).publication
  }
  async revokePublication(
    publication: Pick<KnowledgePublication, 'owner' | 'version'> & {
      draft: Pick<PublicationDraft, 'publicationId'>
    }
  ) {
    const payload = {
      owner: publication.owner,
      publicationId: publication.draft.publicationId,
      version: publication.version,
    }
    return this.invoke(
      'P-KNOWLEDGE',
      'revokePublication',
      payload,
      (v): v is Record<string, unknown> => !!v && typeof v === 'object',
      { mutation: true, revision: publication.version }
    )
  }
  async retrieve(
    publication: KnowledgePublication,
    query: string,
    signal?: AbortSignal
  ): Promise<KnowledgeRetrieval> {
    return (
      await this.invoke(
        'P-KNOWLEDGE',
        'retrieveKnowledge',
        {
          owner: publication.owner,
          publicationId: publication.draft.publicationId,
          version: publication.version,
          query,
          limit: 10,
        },
        isKnowledgeRetrieveResult,
        {},
        signal
      )
    ).retrieval
  }
  async listSubscriptions(
    after?: string,
    signal?: AbortSignal
  ): Promise<Page<AutomationSubscription>> {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'listSubscriptions',
        { after },
        isSubscriptionListResult,
        { management: 'automation' },
        signal
      )
    ).page
  }
  async previewSubscription(
    draft: AutomationTaskDraft
  ): Promise<{ nextFireAtMs?: number | null; periodBudget?: AutomationPeriodBudgetPreview }> {
    return this.invoke(
      'P-AUTOMATION',
      'previewSubscription',
      { draft, consentRef: 'preview-only' },
      (v): v is { nextFireAtMs?: number | null; periodBudget?: AutomationPeriodBudgetPreview } =>
        !!v &&
        typeof v === 'object' &&
        'nextFireAtMs' in v &&
        modelSelectionKey((v as Record<string, unknown>).modelSelection) ===
          modelSelectionKey(draft.modelSelection) &&
        (draft.periodBudget
          ? isAutomationPeriodBudgetPreview((v as Record<string, unknown>).periodBudget) &&
            periodBudgetKey(
              ((v as Record<string, unknown>).periodBudget as AutomationPeriodBudgetPreview)
                .configuration
            ) === periodBudgetKey(draft.periodBudget)
          : (v as Record<string, unknown>).periodBudget == null),
      {}
    )
  }
  async saveSubscription(draft: AutomationTaskDraft, expectedRevision = 0) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'saveSubscription',
        { draft, consentRef: createRandomUuid() },
        (value): value is { subscription: AutomationSubscription } =>
          isSubscriptionReadResult(value) &&
          modelSelectionKey((value.subscription.draft as AutomationTaskDraft).modelSelection) ===
            modelSelectionKey(draft.modelSelection) &&
          periodBudgetKey(value.subscription.draft.periodBudget) ===
            periodBudgetKey(draft.periodBudget),
        { mutation: true, revision: expectedRevision }
      )
    ).subscription
  }
  async setSubscriptionEnabled(subscription: AutomationSubscription, enabled: boolean) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'setSubscriptionEnabled',
        { subscriptionId: subscription.draft.id, enabled },
        isSubscriptionReadResult,
        { mutation: true, revision: subscription.revision }
      )
    ).subscription
  }
  async removeSubscription(subscription: AutomationSubscription) {
    await this.invoke(
      'P-AUTOMATION',
      'removeSubscription',
      { id: subscription.draft.id },
      (value): value is { removed: true } =>
        !!value && typeof value === 'object' && 'removed' in value && value.removed === true,
      {
        mutation: true,
        revision: subscription.revision,
        management: 'automation',
        completedOnly: true,
        unconfirmedCode: 'AUTOMATION_SUBSCRIPTION_REMOVAL_UNCONFIRMED',
      }
    )
  }
  async listRuns(after?: string, signal?: AbortSignal): Promise<Page<AutomationRun>> {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'listAutomationRuns',
        { after },
        isAutomationRunListResult,
        { management: 'automation' },
        signal
      )
    ).page
  }
  async listApplicationSources(signal?: AbortSignal): Promise<IntegrationTaskCapabilitySourceDescriptor[]> {
    const result = await this.invoke(
      'P-CONNECTION',
      'listConnections',
      { category: 'applications', limit: 10 },
      (
        value: unknown
      ): value is { taskSources: IntegrationTaskCapabilitySourceDescriptor[]; taskSourcesState: string } =>
        !!value &&
        typeof value === 'object' &&
        'taskSources' in value &&
        Array.isArray(value.taskSources) &&
        value.taskSources.length <= 200 &&
        value.taskSources.every(isIntegrationTaskCapabilitySourceDescriptor) &&
        'taskSourcesState' in value &&
        ['observed', 'unknown', 'truncated'].includes(String(value.taskSourcesState)),
      { completedOnly: true },
      signal
    )
    if (result.taskSourcesState !== 'observed')
      throw new KnowledgeOperationError('AUTOMATION_APPLICATION_SOURCE_UNAVAILABLE')
    return result.taskSources
  }
  pendingApplicationSelection() {
    const first = this.applicationSelections.entries().next().value
    return first ? { operationId: first[0], params: structuredClone(first[1]) } : undefined
  }
  async selectApplicationEventSource(
    source: IntegrationTaskCapabilitySourceChoice,
    resourceUri: string,
    signal?: AbortSignal
  ): Promise<SelectedAutomationApplicationSource> {
    const pending = this.pendingApplicationSelection()
    if (pending)
      throw new KnowledgeOperationError(
        'AUTOMATION_APPLICATION_SELECTION_UNCONFIRMED',
        pending.operationId,
        true
      )
    const params: AutomationApplicationSelectionParams = {
      source: structuredClone(source),
      resourceUri,
      readConsentRef: createRandomUuid(),
    }
    if (!isAutomationApplicationSelectionParams(params))
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_PAYLOAD')
    const operationId = createRandomUuid()
    this.applicationSelections.set(operationId, params)
    try {
      const receipt = await this.invoke(
        'P-AUTOMATION',
        'selectApplicationEventSource',
        { ...params },
        isAutomationApplicationSelectionReceipt,
        { mutation: true, operationId, completedOnly: true, management: 'automation' },
        signal
      )
      if (
        !sameKnowledgeOwner(receipt.owner, this.scope) ||
        JSON.stringify([receipt.source.sourceRef, receipt.source.accountRef]) !==
          JSON.stringify([params.source.sourceRef, params.source.accountRef]) ||
        !receipt.sourceRef.startsWith('application-events-')
      )
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
      this.applicationSelections.delete(operationId)
      return {
        sourceRef: receipt.sourceRef,
        selectionRevision: receipt.selectionRevision,
        owner: this,
      }
    } catch (error) {
      if (error instanceof KnowledgeOperationError && !error.uncertain)
        this.applicationSelections.delete(operationId)
      throw error
    }
  }
  async reconcileApplicationEventSelection(
    operationId: string,
    signal?: AbortSignal
  ): Promise<{ phase: string; selection?: SelectedAutomationApplicationSource }> {
    if (!this.applicationSelections.has(operationId))
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    const { receipt } = await this.inspectOperation(operationId, signal)
    if (
      receipt.operationId !== operationId ||
      receipt.port !== 'P-AUTOMATION' ||
      receipt.method !== 'selectApplicationEventSource' ||
      !sameKnowledgeOwner(receipt.scope, this.scope) ||
      receipt.scope.identityGeneration !== this.scope.identityGeneration ||
      receipt.scope.targetRevision !== this.scope.targetRevision
    )
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
    if (receipt.phase === 'completed') {
      if (
        receipt.entityRef?.kind !== 'input' ||
        !receipt.entityRef.id.startsWith('application-events-') ||
        !receipt.entityRef.revision
      )
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT', operationId, true)
      this.applicationSelections.delete(operationId)
      return {
        phase: receipt.phase,
        selection: {
          sourceRef: receipt.entityRef.id,
          selectionRevision: receipt.entityRef.revision,
          owner: this,
        },
      }
    }
    if (['rejected', 'failed', 'cancelled'].includes(receipt.phase))
      this.applicationSelections.delete(operationId)
    return { phase: receipt.phase }
  }
  async listDeliveryConnections(after?: string, signal?: AbortSignal) {
    return this.invoke(
      'P-CONNECTION',
      'listConnections',
      { category: 'channels', after, limit: 10 },
      isDeliveryConnectionPage,
      { completedOnly: true },
      signal
    )
  }
  async listDeliveryDestinations(connectionId: string, after?: string, signal?: AbortSignal) {
    const result = await this.invoke(
      'P-CONNECTION',
      'readResourceGrant',
      { connectionId, destinationAfter: after },
      isDeliveryDestinationPage,
      { completedOnly: true },
      signal
    )
    if (result.connectionId !== connectionId)
      throw new KnowledgeOperationError('AUTOMATION_DELIVERY_SOURCE_CHANGED')
    return { items: result.destinations, nextCursor: result.destinationNextCursor }
  }
  async listConnectionEventSources(after?: string, signal?: AbortSignal) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'listConnectionEventSources',
        { after },
        isAutomationConnectionEventSourceListResult,
        {
          management: 'automation',
          completedOnly: true,
          unconfirmedCode: 'AUTOMATION_CONNECTION_SOURCE_READ_UNCONFIRMED',
        },
        signal
      )
    ).page
  }
  async listQuarantinedEvents(after?: string, signal?: AbortSignal) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'listQuarantinedEvents',
        { after },
        isAutomationQuarantineListResult,
        {
          management: 'automation',
          completedOnly: true,
          unconfirmedCode: 'AUTOMATION_QUARANTINE_READ_UNCONFIRMED',
        },
        signal
      )
    ).page
  }
  async readRun(runId: string, signal?: AbortSignal) {
    const run = (
      await this.invoke(
        'P-AUTOMATION',
        'readAutomationRun',
        { runId },
        isAutomationRunReadResult,
        {},
        signal
      )
    ).run
    if (run.id !== runId || !sameKnowledgeOwner(run.owner, this.scope))
      throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
    return run
  }
  async cancelRun(run: AutomationRun) {
    return (
      await this.invoke(
        'P-AUTOMATION',
        'cancelAutomationRun',
        { runId: run.id },
        isAutomationRunReadResult,
        { mutation: true, management: 'automation' }
      )
    ).run
  }
  async controlDelivery(run: AutomationRun, action: 'cancel' | 'reconcile') {
    return (
      await this.invoke(
        'P-AUTOMATION',
        action === 'cancel' ? 'cancelAutomationDelivery' : 'reconcileAutomationDelivery',
        { runId: run.id },
        isAutomationRunReadResult,
        { mutation: true, management: 'automation' }
      )
    ).run
  }
  async hideRun(run: AutomationRun) {
    return this.invoke(
      'P-AUTOMATION',
      'hideAutomationRun',
      { id: run.id },
      (v): v is Record<string, unknown> => !!v && typeof v === 'object',
      { mutation: true, management: 'automation' }
    )
  }
}
