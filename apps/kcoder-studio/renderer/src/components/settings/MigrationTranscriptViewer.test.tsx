import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MigrationTranscriptViewer } from './MigrationTranscriptViewer'
const { api }=vi.hoisted(()=>({api:{transcriptPage:vi.fn(),transcriptBlocks:vi.fn(),transcriptText:vi.fn(),branchRead:vi.fn(),branchPage:vi.fn(),branchText:vi.fn()}}))
vi.mock('@/kcoder/gatewayMigration',()=>({createMigrationApi:()=>api}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('@/components/chat/AssistantMarkdown',()=>({AssistantMarkdown:({content,historical}:{content:string,historical?:boolean})=><div data-testid="readonly-markdown" data-history={historical}>{content}</div>}))
vi.mock('./MigrationBranchTools',()=>({MigrationBranchTools:()=>null}))
vi.mock('./MigrationContinuationPanel',()=>({MigrationContinuationPanel:()=>null}))
const block={index:0,kind:'text',preview:'Beginning',sourceBytes:200_000,decodedBytes:190_000,bodyAvailable:true,callId:null,name:null,namespace:null,sourceType:null,outcome:null}
const row={record:0,kind:'message',role:'assistant',timestamp:null,sourceId:'message',parentId:null,hidden:false,sidechain:false,compactSummary:false,blocks:[block],totalBlocks:12,nextBlockCursor:10,diagnostics:[],totalDiagnostics:0}
const page={source:'codex',sourceSessionId:'source',title:'Original title',project:null,items:[row],totalRecords:1,nextCursor:null,normalizationComplete:true,adapterRevision:'fixed'}
const props={deviceId:'target',jobId:'job',isCurrent:()=>true}
beforeEach(()=>{vi.resetAllMocks();api.transcriptPage.mockResolvedValue(page);api.branchRead.mockResolvedValue({choice:null,progress:null,workerRunning:false,workerError:null})})

test('large body navigation replaces the bounded window and supplies only issued text cursors',async()=>{
  api.transcriptText.mockResolvedValueOnce({text:'First body window',nextCursor:'sealed-next',sourceBytes:200_000,decodedBytes:190_000,encoding:'json_string'})
    .mockResolvedValueOnce({text:'Second body window',nextCursor:null,sourceBytes:200_000,decodedBytes:190_000,encoding:'json_string'})
  render(<MigrationTranscriptViewer {...props} />)
  await screen.findByText('Beginning')
  fireEvent.click(screen.getByRole('button',{name:'transcript.read_body'}))
  await screen.findByText('First body window')
  const body=screen.getByTestId('historical-body')
  fireEvent.click(within(body).getByRole('button',{name:'next'}))
  await screen.findByText('Second body window')
  expect(screen.queryByText('First body window')).not.toBeInTheDocument()
  expect(api.transcriptText).toHaveBeenLastCalledWith({jobId:'job',record:0,blockIndex:0,cursor:'sealed-next'},expect.objectContaining({signal:expect.any(AbortSignal)}))
  expect(screen.getByTestId('readonly-markdown')).toHaveAttribute('data-history','true')
})

test('record block pagination replaces the window and supports returning to the first blocks',async()=>{
  api.transcriptBlocks.mockResolvedValueOnce({record:0,blocks:[{...block,index:10,preview:'Last blocks'}],totalBlocks:12,nextCursor:null})
    .mockResolvedValueOnce({record:0,blocks:[block],totalBlocks:12,nextCursor:10})
  render(<MigrationTranscriptViewer {...props} />)
  await screen.findByText('Beginning')
  fireEvent.click(screen.getByRole('button',{name:'transcript.next_blocks'}))
  await screen.findByText('Last blocks')
  expect(screen.queryByText('Beginning')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'transcript.previous_blocks'}))
  await screen.findByText('Beginning')
  expect(api.transcriptBlocks).toHaveBeenLastCalledWith({jobId:'job',record:0,cursor:0},expect.objectContaining({signal:expect.any(AbortSignal)}))
})

test('an older archive target gets an upgrade notice without a fake empty transcript',async()=>{
  api.transcriptPage.mockRejectedValue(new Error('migration_history_read_update_required'))
  render(<MigrationTranscriptViewer {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('errors.migration_history_read_update_required')
  await waitFor(()=>expect(screen.queryByTestId('migration-transcript-scroll')).not.toBeInTheDocument())
})

test('an expired connection cursor can restart the body at its first page without replaying a mutation',async()=>{
  api.transcriptText.mockResolvedValueOnce({text:'First window',nextCursor:'old-connection-cursor',sourceBytes:200_000,decodedBytes:190_000,encoding:'json_string'})
    .mockRejectedValueOnce(new Error('history_display_invalid_cursor'))
    .mockResolvedValueOnce({text:'Reloaded first window',nextCursor:'new-connection-cursor',sourceBytes:200_000,decodedBytes:190_000,encoding:'json_string'})
  render(<MigrationTranscriptViewer {...props} />)
  await screen.findByText('Beginning')
  fireEvent.click(screen.getByRole('button',{name:'transcript.read_body'}))
  await screen.findByText('First window')
  fireEvent.click(within(screen.getByTestId('historical-body')).getByRole('button',{name:'next'}))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button',{name:'transcript.reload_body'}))
  await screen.findByText('Reloaded first window')
  expect(api.transcriptText).toHaveBeenLastCalledWith({jobId:'job',record:0,blockIndex:0,cursor:undefined},expect.objectContaining({signal:expect.any(AbortSignal)}))
})

test('current branch rows keep physical provenance but send selected positions to their body endpoint',async()=>{
  const progress={viewId:'selected-view',sequence:7,source:'codex',stage:'ready',checks:10,writtenItems:1,totalItems:1,structuralComplete:true,sourceRecordsWithDiagnostics:0,issues:[],cancelRequested:false,failureCode:null}
  api.branchRead.mockResolvedValue({choice:{viewId:'selected-view',relatedJobIds:[]},progress,workerRunning:false,workerError:null})
  api.branchPage.mockResolvedValue({progress,title:'Current branch',sourceSessionId:'source',items:[{position:0,sourceIndex:0,sourceSessionId:'source',replacementIndex:1,omittedBlocks:2,record:{...row,record:99,blocks:[{...block,preview:'Selected preview'}],nextBlockCursor:null}}],nextCursor:null})
  api.branchText.mockResolvedValue({text:'Selected full body',nextCursor:null,sourceBytes:100,decodedBytes:98,encoding:'json_string'})
  render(<MigrationTranscriptViewer {...props} />)
  await waitFor(()=>expect(screen.getByRole('button',{name:'branch.current'})).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'branch.current'}))
  await screen.findByText('Selected preview')
  expect(screen.queryByText('Beginning')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'transcript.read_body'}))
  await screen.findByText('Selected full body')
  expect(api.branchText).toHaveBeenCalledExactlyOnceWith({jobId:'job',viewId:'selected-view',position:0,blockIndex:0,cursor:undefined},expect.objectContaining({signal:expect.any(AbortSignal)}))
})
