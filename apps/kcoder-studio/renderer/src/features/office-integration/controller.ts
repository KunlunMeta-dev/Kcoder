import type {
  IntegrationReply,
  OfficeArtifactRef,
  OfficeAssistantDefinition,
  OfficeCanonicalSourceReadResult,
  OfficeMaterialReceipt,
} from '../../../../shared/generated/contracts.js'
import {
  isIntegrationRuntimeAcceptance,
  isOfficeCanonicalSourceReadResult,
} from '../../../../shared/generated/contractGuards.mjs'

export type { OfficeMaterialReceipt } from '../../../../shared/generated/contracts.js'
export type {
  ResourceTransport as OfficeTransport,
  ResourceMutation as OfficeMutation,
} from '../integration-resources/controller'
import type {
  ResourceTransport as OfficeTransport,
  ResourceMutation as OfficeMutation,
} from '../integration-resources/controller'
export { ResourceClientError as OfficeClientError } from '../integration-resources/controller'
import {
  ResourceController,
  ResourceClientError as OfficeClientError,
} from '../integration-resources/controller'
export class OfficeController extends ResourceController<OfficeTransport> {
  override async call<T extends Record<string, unknown>>(
    method: string,
    payload: Record<string, unknown>,
    mutation?: OfficeMutation,
    signal?: AbortSignal
  ): Promise<T> {
    const result = await super.call<T>(method, payload, mutation, signal)
    if (method === 'assistant/adopt' && payload.startTask === true) {
      const task = (result as Record<string, unknown>).nativeTask
      if (
        !isIntegrationRuntimeAcceptance(task) ||
        !['queued', 'running'].includes(task.state) ||
        (!task.turnId && !task.taskId)
      )
        throw new OfficeClientError(
          'OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED',
          'reconcile_original',
          mutation?.operationId
        )
    }
    return result
  }

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
export type {
  ResourceList as OfficeList,
  AgentDefinitionItem as OfficeAssistantItem,
} from '../integration-resources/controller'
import type {
  ResourceList as OfficeList,
  AgentDefinitionItem as OfficeAssistantItem,
} from '../integration-resources/controller'
export function publicOfficeError(error: unknown): { code: string; operationId?: string; recovery: string } {
  return error instanceof OfficeClientError ? { code: error.code, operationId: error.operationId, recovery: error.recovery } : { code: 'OFFICE_OPERATION_FAILED', recovery: 'retry_read' }
}
export type OfficePortReply = IntegrationReply
