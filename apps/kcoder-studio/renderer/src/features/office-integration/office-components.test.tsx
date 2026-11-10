import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { IntegrationRequest, OfficeArtifactManifest } from '../../../../shared/generated/contracts.js'
import { OfficeController } from './controller'
import { ArtifactCollection } from './ArtifactCollection'
import { CanonicalSourceDetails } from './CanonicalSourceDetails'
import { officeIntegrationResources } from './locales'
const owner = { accountId: 'a', targetId: 't', workspaceId: null }
const scope = () => ({ ...owner, identityGeneration: '1', targetRevision: '1' })
const reply = (request: IntegrationRequest, result: Record<string, unknown>) => ({ contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, status: 'completed', entityRevision: null, observedAt: '2026-10-24T00:00:00Z', result, error: null })
beforeAll(async () => { await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { officeIntegration: officeIntegrationResources.en }, 'zh-CN': { officeIntegration: officeIntegrationResources['zh-CN'] } }, interpolation: { escapeValue: false } }) })
afterEach(cleanup)
it('old artifacts explicitly show that complete generation source was not retained',async()=>{
  const manifest:OfficeArtifactManifest={schemaVersion:1,id:'old-office-file',revision:1,owner,task:{threadId:'thread',turnId:'turn'},kind:'document',title:'Old deliverable',format:'docx',bytes:8,sha256:'a'.repeat(64),sourceRefs:[],verification:{status:'pending',completedChecks:[],pendingChecks:['reader'],readerStatus:'pending',formulaCalculation:'not_applicable'},createdAtMs:1}
  const call=vi.fn(async(_method:string,request:IntegrationRequest)=>reply(request,{availability:'not_recorded',source:null,chunk:null,offset:0,nextOffset:null,complete:false}))
  render(<CanonicalSourceDetails controller={new OfficeController({call},scope)} manifest={manifest}/>);
  await screen.findByText('No generation source was retained. This deliverable cannot be continued from a complete source.');expect(screen.queryByRole('button',{name:'Inspect generation source'})).toBeNull();expect(call.mock.calls[0][1].payload.metadataOnly).toBe(true)
})
describe('Office product components with contract-only providers', () => {
  it('keeps visualization collapsed until final and reads dataset without model work', async () => {
    const manifest: OfficeArtifactManifest = { schemaVersion: 1, id: 'A', revision: 1, owner, task: { threadId: 'thread', turnId: 'turn' }, kind: 'chart', title: 'Sales chart', format: 'json', bytes: 8, sha256: 'a'.repeat(64), sourceRefs: [], verification: { status: 'partial', completedChecks: ['dataset_schema'], pendingChecks: ['reader'], readerStatus: 'pending', formulaCalculation: 'not_applicable' }, dataset: { id: 'D', revision: 1 }, createdAtMs: 1 }
    const call = vi.fn(async (method: string, request: IntegrationRequest) => reply(request, method.endsWith('/list') ? { items: [manifest], total: 1, nextCursor: null } : { dataset: { id: 'D', revision: 1 }, columns: [{ key: 'amount', title: 'Amount', kind: 'number', unit: '元' }], rows: [[1234.56],[null]], totalRows: 2, matchedRows: 2, nextCursor: null, querySha256: 'b'.repeat(64), sourceRefs: [] }))
    const client = new OfficeController({ call }, scope)
    const view = render(<ArtifactCollection controller={client} threadId="thread" phase="running" onExportReady={() => {}} />)
    await screen.findByText('Sales chart')
    expect(call.mock.calls.some(([method]) => method.includes('dataset/'))).toBe(false)
    expect(screen.queryByRole('img')).toBeNull()
    view.rerender(<ArtifactCollection controller={client} threadId="thread" phase="completed" onExportReady={() => {}} />)
    await waitFor(() => expect(screen.getByRole('cell', { name: '1234.56', exact: true })).toBeDefined())
    expect(screen.getByRole('cell', { name: 'Unknown / missing', exact: true })).toBeDefined()
    expect(screen.getByRole('img')).toBeDefined()
    expect(call.mock.calls.every(([method]) => !method.includes('runtime') && !method.includes('generate'))).toBe(true)
  })
})

it('fixed action items preserve unknown owners and forms only prepare native intents', async () => {
  const { ArtifactPresentationView } = await import('./ArtifactPresentationView')
  const base: OfficeArtifactManifest = { schemaVersion: 1, id: 'F', revision: 1, owner, task: { threadId: 'thread', turnId: 'turn' }, kind: 'form', title: 'Follow up', format: 'json', bytes: 8, sha256: 'a'.repeat(64), sourceRefs: [], verification: { status: 'partial', completedChecks: ['declarative_schema'], pendingChecks: ['semantic_acceptance'], readerStatus: 'unavailable', formulaCalculation: 'not_applicable' }, createdAtMs: 1 }
  const call = vi.fn(async (_method: string, request: IntegrationRequest) => reply(request, { intent: { operationId: request.operationId, action: 'create_task', inputs: request.payload.inputs }, businessComplete: false }))
  const controller = new OfficeController({ call }, scope); const onActionIntent = vi.fn()
  const view = render(<ArtifactPresentationView controller={controller} manifest={{ ...base, kind: 'action_items', presentation: { kind: 'action_items', items: [{ id: 'action', text: 'Check the original source', status: 'unknown', assignee: null, due: null, sourceRefs: [] }] } }} onExportReady={() => {}} />)
  expect(screen.getByText('Check the original source')).toBeDefined()
  expect(screen.getAllByText('Unknown / missing')).toHaveLength(2)
  view.rerender(<ArtifactPresentationView controller={controller} manifest={{ ...base, presentation: { kind: 'form', schema: { type: 'object', properties: { title: { type: 'string', title: 'Task title' } }, required: ['title'] }, initialValues: {}, purpose: 'Prepare follow up' } }} onExportReady={() => {}} onActionIntent={onActionIntent} />)
  fireEvent.change(screen.getByLabelText('Task title · Required'), { target: { value: 'Check tomorrow' } })
  fireEvent.click(screen.getByText('Prepare follow-up task'))
  await waitFor(() => expect(onActionIntent).toHaveBeenCalledTimes(1))
  expect(call.mock.calls[0][0]).toBe('integrations/artifact/prepareAction')
  expect(call.mock.calls.every(([method]) => !method.includes('runtime') && !method.includes('send'))).toBe(true)
})
