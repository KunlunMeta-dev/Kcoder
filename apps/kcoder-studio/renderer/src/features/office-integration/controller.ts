import type { IntegrationReply, IntegrationRequest, IntegrationScope, OfficeArtifactRef, OfficeAssistantDefinition, OfficeResourceRef, OfficeCanonicalSourceReadResult, OfficeMaterialReceipt } from '../../../../shared/generated/contracts.js'
import { isIntegrationReply, isIntegrationRuntimeAcceptance, isOfficeCanonicalSourceReadResult } from '../../../../shared/generated/contractGuards.mjs'

export type { OfficeMaterialReceipt } from '../../../../shared/generated/contracts.js'
export interface OfficeTransport {
  prepareInput?(file: File, options: { scope: IntegrationScope; operationId: string; signal: AbortSignal; onProgress: (bytes: number) => void }): Promise<unknown>
  call(method: string, request: IntegrationRequest, options: { signal?: AbortSignal }): Promise<unknown>
}
export interface OfficeMutation { operationId: string; expectedRevision?: string }
export class OfficeClientError extends Error {
  readonly code: string
  readonly operationId?: string
  readonly recovery: string
  constructor(code: string, recovery: string, operationId?: string) {
    super(code)
    this.name = 'OfficeClientError'; this.code = code; this.recovery = recovery; this.operationId = operationId
  }
}
const writes = new Set(['assistant/skills/install','assistant/market/install','assistant/deleteDraft','assistant/saveDraft','assistant/saveVersion','assistant/adopt','assistant/archive','assistant/export','assistant/import','artifact/export','artifact/verify','artifact/prepareAction','artifact/executeAction','dataset/create','dataset/export','office/generate'])
const reads = new Set(['assistant/skills/catalog','assistant/market/read','assistant/market/list','assistant/package/read','assistant/list','assistant/read','assistant/versions','assistant/validate','artifact/list','artifact/read','artifact/source','artifact/verification','dataset/schema','dataset/page','dataset/query','office/readiness','office/readOperation'])
export class OfficeController {
  private readonly transport: OfficeTransport
  private readonly currentScope: () => IntegrationScope
  constructor(transport: OfficeTransport, currentScope: () => IntegrationScope) { this.transport = transport; this.currentScope = currentScope }
  scopeKey(): string { return JSON.stringify(this.currentScope()) }
  operation(): OfficeMutation { return { operationId: `office-${crypto.randomUUID()}` } }
  async canonicalSource(reference:OfficeArtifactRef, signal?:AbortSignal):Promise<OfficeCanonicalSourceReadResult> {
    const result=await this.call<Record<string,unknown>>('artifact/source',{reference,metadataOnly:true},undefined,signal)
    if(!isOfficeCanonicalSourceReadResult(result))throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
    if(result.availability==='available') {
      const source=result.source;const scope=this.currentScope()
      if(!source||source.artifact.id!==reference.id||source.artifact.revision!==reference.revision
        ||source.owner.accountId!==scope.accountId||source.owner.targetId!==scope.targetId||source.owner.workspaceId!==scope.workspaceId||(source.owner.organizationId??null)!==(scope.organizationId??null)
        ||!Number.isSafeInteger(source.specificationBytes)||source.specificationBytes<=0||source.specificationBytes>1024*1024||!/^[a-f0-9]{64}$/i.test(source.specificationSha256)||result.chunk!==null||result.complete)throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
    } else if(result.source!==null||result.chunk!==null||result.complete)throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
    return result
  }
  async canonicalSourceText(reference:OfficeArtifactRef,signal:AbortSignal):Promise<string> {
    const key=this.scopeKey();const metadata=await this.canonicalSource(reference,signal)
    if(metadata.availability!=='available'||!metadata.source)throw new OfficeClientError('OFFICE_CANONICAL_SOURCE_MISSING','none')
    const source=metadata.source;if(source.specificationBytes>1024*1024)throw new OfficeClientError('OFFICE_INVALID_REPLY','none')
    const encoder=new TextEncoder();let text='';let bytes=0;let offset=0
    for(let page=0;page<32;page++) {
      if(signal.aborted||this.scopeKey()!==key)throw new OfficeClientError('OFFICE_SCOPE_CHANGED','retry_read')
      const part=await this.call<Record<string,unknown>>('artifact/source',{reference,metadataOnly:false,expectedSha256:source.specificationSha256,offset,limit:64*1024},undefined,signal)
      if(!isOfficeCanonicalSourceReadResult(part)||part.source?.id!==source.id||part.source.specificationSha256!==source.specificationSha256||part.source.revision!==source.revision||part.offset!==offset||typeof part.chunk!=='string')throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
      const length=encoder.encode(part.chunk).byteLength;if(length>64*1024||bytes+length>source.specificationBytes)throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
      text+=part.chunk;bytes+=length
      if(part.complete) {
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('')
        if(signal.aborted||this.scopeKey()!==key||bytes!==source.specificationBytes||digest!==source.specificationSha256)throw new OfficeClientError('OFFICE_CANONICAL_SOURCE_CORRUPT','retry_read')
        return text
      }
      if(part.nextOffset!==offset+length||length===0)throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read');offset=part.nextOffset
    }
    throw new OfficeClientError('OFFICE_INVALID_REPLY','retry_read')
  }
  async call<T extends Record<string, unknown>>(method: string, payload: Record<string, unknown>, mutation?: OfficeMutation, signal?: AbortSignal): Promise<T> {
    if ((!reads.has(method) && !writes.has(method)) || (writes.has(method) && !mutation)) throw new OfficeClientError('OFFICE_INVALID_REQUEST', 'none')
    const scope = structuredClone(this.currentScope()); const key = JSON.stringify(scope)
    const request: IntegrationRequest = { contractVersion: 'parallel-v1', requestId: `request-${crypto.randomUUID()}`, scope, timeoutMs: (method.startsWith('assistant/market/') || method.startsWith('assistant/skills/')) ? 60_000 : 30_000, payload,
      ...(mutation ? { operationId: mutation.operationId, ...(mutation.expectedRevision ? { expectedRevision: mutation.expectedRevision } : {}) } : {}) }
    let reply: unknown
    try { reply = await this.transport.call(`integrations/${method}`, request, { signal }) }
    catch (error) {
      if (error instanceof OfficeClientError) throw error
      throw new OfficeClientError(writes.has(method) ? 'OFFICE_OUTCOME_UNKNOWN' : signal?.aborted ? 'OFFICE_CANCELLED' : 'OFFICE_UNAVAILABLE', writes.has(method) ? 'reconcile_original' : 'retry_read', mutation?.operationId)
    }
    if (key !== this.scopeKey()) throw new OfficeClientError('OFFICE_SCOPE_CHANGED', mutation ? 'reconcile_original' : 'retry_read', mutation?.operationId)
    if (!isIntegrationReply(reply) || reply.requestId !== request.requestId || reply.operationId !== (request.operationId ?? null)) throw new OfficeClientError('OFFICE_INVALID_REPLY', mutation ? 'reconcile_original' : 'retry_read', mutation?.operationId)
    if (reply.status !== 'completed' && reply.status !== 'accepted') throw new OfficeClientError(reply.error?.code ?? 'OFFICE_OUTCOME_UNKNOWN', reply.error?.recovery ?? 'reconcile_original', mutation?.operationId)
    if (reply.status === 'accepted' && method !== 'assistant/adopt') throw new OfficeClientError('OFFICE_OPERATION_PENDING', 'reconcile_original', mutation?.operationId)
    if (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)) throw new OfficeClientError('OFFICE_INVALID_REPLY', mutation ? 'reconcile_original' : 'retry_read', mutation?.operationId)
    if (method === 'assistant/adopt' && payload.startTask === true) {
      const task = reply.result.nativeTask
      if (!isIntegrationRuntimeAcceptance(task) || !['queued','running'].includes(task.state) || (!task.turnId && !task.taskId)) throw new OfficeClientError('OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED', 'reconcile_original', mutation?.operationId)
    }
    return reply.result as T
  }
  supportsInput(): boolean { return typeof this.transport.prepareInput === 'function' }
  async prepareInput(file: File, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<OfficeMaterialReceipt> {
    if (!this.transport.prepareInput) throw new OfficeClientError('OFFICE_INPUT_PROVIDER_UNAVAILABLE', 'repair_configuration')
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 100 * 1024 * 1024) throw new OfficeClientError('OFFICE_INPUT_TOO_LARGE', 'none')
    const scope = structuredClone(this.currentScope()); const key = this.scopeKey(); const operation = this.operation()
    let value: unknown
    try { value = await this.transport.prepareInput(file, { scope, operationId: operation.operationId, signal, onProgress: bytes => { if (!signal.aborted && key === this.scopeKey() && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= file.size) onProgress(bytes) } }) }
    catch { throw new OfficeClientError('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original', operation.operationId) }
    if (key !== this.scopeKey()) throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'reconcile_original', operation.operationId)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficeClientError('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original', operation.operationId)
    const receipt = value as Partial<OfficeMaterialReceipt>
    if (receipt.kind !== 'office_input' || receipt.status !== 'accepted' || receipt.revision !== 1 || receipt.operationId !== operation.operationId
      || typeof receipt.inputId !== 'string' || !receipt.inputId || receipt.inputId.length > 256 || receipt.bytes !== file.size
      || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(receipt.sha256) || receipt.filename !== file.name || typeof receipt.mediaType !== 'string'
      || receipt.owner?.accountId !== scope.accountId || receipt.owner?.targetId !== scope.targetId || receipt.owner?.workspaceId !== scope.workspaceId
      || (receipt.owner?.organizationId ?? null) !== (scope.organizationId ?? null) || 'path' in value || 'native' in value) throw new OfficeClientError('OFFICE_INPUT_UNCONFIRMED', 'reconcile_original', operation.operationId)
    return receipt as OfficeMaterialReceipt
  }
  listAssistants(cursor?: string, signal?: AbortSignal, language='zh-CN') { return this.call<OfficeList<OfficeAssistantItem>>('assistant/list', { limit: 10, language, ...(cursor ? { cursor } : {}) }, undefined, signal) }
  adopt(definition: OfficeAssistantDefinition, version: string, inputs: unknown, mutation: OfficeMutation, signal?: AbortSignal) {
    return this.call<Record<string, unknown>>('assistant/adopt', { id: definition.id, version, language: definition.language, inputs, startTask: true }, mutation, signal)
  }
  artifacts(threadId: string, cursor?: string, signal?: AbortSignal, turnId?: string) { return this.call<OfficeList<Record<string, unknown>>>('artifact/list', { threadId, ...(turnId ? { turnId } : {}), limit: 10, ...(cursor ? { cursor } : {}) }, undefined, signal) }
  executePreparedAction(prepared: { intent: { operationId: string }; executionOperationId: string }, signal?: AbortSignal) {
    return this.call<Record<string, unknown>>('artifact/executeAction', { preparedOperationId: prepared.intent.operationId }, { operationId: prepared.executionOperationId }, signal)
  }
  readArtifact(reference: OfficeArtifactRef, signal?: AbortSignal) { return this.call<Record<string, unknown>>('artifact/read', { reference }, undefined, signal) }
}
export interface OfficeList<T> extends Record<string, unknown> { items: T[]; total: number; nextCursor: string | null }
export interface OfficeAssistantItem { definition: OfficeAssistantDefinition; builtin: boolean; version?: string; draftRevision?: number; organizationPublication?: OfficeResourceRef }
export function publicOfficeError(error: unknown): { code: string; operationId?: string; recovery: string } {
  return error instanceof OfficeClientError ? { code: error.code, operationId: error.operationId, recovery: error.recovery } : { code: 'OFFICE_OPERATION_FAILED', recovery: 'retry_read' }
}
export type OfficePortReply = IntegrationReply
