import { describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts.js'
import { OfficeClientError, OfficeController } from './controller'
import { fieldValue, readInputFields } from './inputSchema'
const scope = (): IntegrationScope => ({ accountId: 'a', targetId: 't', workspaceId: null, identityGeneration: '1', targetRevision: '1' })
const reply = (request: IntegrationRequest, result: Record<string, unknown>) => ({ contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, status: 'completed', entityRevision: null, observedAt: '2026-10-24T00:00:00Z', result, error: null })
it('preserves a known native export preflight failure before any mutation was sent', async () => {
  const preflight = new OfficeClientError('OFFICE_EXPORT_PROVIDER_UNAVAILABLE', 'repair_configuration')
  const client = new OfficeController({ call: async () => { throw preflight } }, scope)
  await expect(client.call('artifact/export', { reference: { id: 'artifact', revision: 1 }, format: 'docx' }, { operationId: 'export-preflight' })).rejects.toBe(preflight)
})
async function canonicalFixture(text:string) {
  const bytes=new TextEncoder().encode(text);const sha=Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('')
  return {schemaVersion:1,id:'canonical-source',revision:1,owner:{accountId:'a',targetId:'t',workspaceId:null},operationId:'actual-operation',task:{threadId:'thread',turnId:'turn'},artifact:{id:'artifact',revision:1},outputSha256:'b'.repeat(64),specificationSha256:sha,specificationBytes:bytes.byteLength,generator:{component:'@kcoder/office-components',version:'0.1.0',schemaRevision:'office-generation/v1',implementationSha256:'c'.repeat(64),dependencyLockSha256:'d'.repeat(64)},inputs:[],createdAtMs:1}
}
describe('Office controller contract consumers', () => {
  it('uses ordinary business RPC and stable supplied mutation identities', async () => {
    const call = vi.fn(async (_method: string, request: IntegrationRequest) => reply(request, { draft: {} }))
    const client = new OfficeController({ call }, scope)
    const operation = client.operation()
    await client.call('assistant/saveDraft', { definition: {} }, operation)
    expect(call.mock.calls[0][0]).toBe('integrations/assistant/saveDraft')
    expect(call.mock.calls[0][1].operationId).toBe(operation.operationId)
    expect(call.mock.calls[0][1].scope).toEqual(scope())
    await expect(client.call('arbitrary/port', {})).rejects.toMatchObject({ code: 'OFFICE_INVALID_REQUEST' })
  })
  it('does not retry an uncertain write or leak transport exception text', async () => {
    const call = vi.fn(async () => { throw new Error('private path and credential must not escape') })
    const client = new OfficeController({ call }, scope); const operation = client.operation()
    await expect(client.call('office/generate', {}, operation)).rejects.toMatchObject({ code: 'OFFICE_OUTCOME_UNKNOWN', operationId: operation.operationId, recovery: 'reconcile_original' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('rejects a successful late result after target identity changes', async () => {
    let current = scope()
    const call = vi.fn(async (_method: string, request: IntegrationRequest) => { current = { ...current, identityGeneration: '2' }; return reply(request, { items: [], total: 0, nextCursor: null }) })
    const client = new OfficeController({ call }, () => current)
    await expect(client.listAssistants()).rejects.toMatchObject({ code: 'OFFICE_SCOPE_CHANGED' })
  })
  it('does not interpret malformed success or unrelated operation as completion', async () => {
    const client = new OfficeController({ call: async (_method, request) => ({ ...reply(request, {}), operationId: 'another' }) }, scope)
    await expect(client.listAssistants()).rejects.toMatchObject({ code: 'OFFICE_INVALID_REPLY' })
  })
  it('form conversion keeps material arrays and rejects invalid numbers', () => {
    expect(fieldValue({ type: 'array', items: { type: 'string' } }, 'input-1\n\ninput-2')).toEqual(['input-1', 'input-2'])
    expect(() => fieldValue({ type: 'integer' }, 'not-a-number')).toThrow()
    expect(readInputFields({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }).required.has('title')).toBe(true)
  })
})

it('canonical source requires explicit byte read and verifies the full returned identity',async()=>{
  vi.stubGlobal('crypto',webcrypto)
  try {
    const text=JSON.stringify({schemaVersion:1,title:'完整生成源',paragraphs:['Original content']});const source=await canonicalFixture(text)
    const call=vi.fn(async(_method:string,request:IntegrationRequest)=>reply(request,{availability:'available',source,chunk:request.payload.metadataOnly?null:text,offset:0,nextOffset:null,complete:!request.payload.metadataOnly}))
    const client=new OfficeController({call},scope);const metadata=await client.canonicalSource({id:'artifact',revision:1})
    expect(metadata.chunk).toBeNull();expect(call.mock.calls[0][1].payload.metadataOnly).toBe(true)
    expect(await client.canonicalSourceText({id:'artifact',revision:1},new AbortController().signal)).toBe(text)
    expect(call.mock.calls.at(-1)?.[1].payload.expectedSha256).toBe(source.specificationSha256)
  } finally {vi.unstubAllGlobals()}
})

it('legacy absent source is not an empty editable document',async()=>{
  const call=vi.fn(async(_method:string,request:IntegrationRequest)=>reply(request,{availability:'not_recorded',source:null,chunk:null,offset:0,nextOffset:null,complete:false}))
  const client=new OfficeController({call},scope)
  await expect(client.canonicalSourceText({id:'old-artifact',revision:1},new AbortController().signal)).rejects.toMatchObject({code:'OFFICE_CANONICAL_SOURCE_MISSING'})
  expect(call).toHaveBeenCalledTimes(1)
})

it('corrupt canonical source bytes fail rather than claiming complete source',async()=>{
  vi.stubGlobal('crypto',webcrypto)
  try {
    const source=await canonicalFixture('{"actual":"original"}')
    const client=new OfficeController({call:async(_method,request)=>reply(request,{availability:'available',source,chunk:request.payload.metadataOnly?null:'{ "wrong":"different"}',offset:0,nextOffset:null,complete:!request.payload.metadataOnly})},scope)
    await expect(client.canonicalSourceText({id:'artifact',revision:1},new AbortController().signal)).rejects.toBeDefined()
  } finally {vi.unstubAllGlobals()}
})

it('large material admission is bounded without reading the whole File in the renderer', async () => {
  const prepareInput = vi.fn(async () => ({}))
  const client = new OfficeController({ call: async () => ({}), prepareInput }, scope)
  const file = new File(['test'], 'large.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 })
  await expect(client.prepareInput(file, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'OFFICE_INPUT_TOO_LARGE' })
  expect(prepareInput).not.toHaveBeenCalled()
})
it('late material completion cannot enter a new target and cannot disclose a native path', async () => {
  let current = scope()
  const file = new File(['abc'], 'input.txt', { type: 'text/plain' })
  const client = new OfficeController({ call: async () => ({}), prepareInput: async (_file, options) => { current = { ...current, targetRevision: 'new-target' }; return { kind: 'office_input', inputId: 'opaque', revision: 1, operationId: options.operationId, owner: { accountId: 'a', targetId: 't', workspaceId: null }, filename: file.name, mediaType: file.type, bytes: 3, sha256: 'a'.repeat(64), status: 'accepted' } } }, () => current)
  await expect(client.prepareInput(file, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'OFFICE_SCOPE_CHANGED', recovery: 'reconcile_original' })
})
