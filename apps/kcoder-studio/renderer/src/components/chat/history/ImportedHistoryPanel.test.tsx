import {fireEvent,render,screen,within} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {ImportedHistoryPanel} from './ImportedHistoryPanel'
const {api}=vi.hoisted(()=>({api:{branchPage:vi.fn(),branchBlocks:vi.fn(),branchText:vi.fn()}}))
vi.mock('@/kcoder/gatewayMigration',()=>({createMigrationApi:()=>api}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('@/components/chat/AssistantMarkdown',()=>({AssistantMarkdown:({content,historical}:{content:string,historical?:boolean})=><div data-testid="history-markdown" data-historical={historical}>{content}</div>}))
const record=(i:number)=>({record:i,kind:'message',role:i%2?'assistant':'user',timestamp:null,sourceId:`source-${i}`,parentId:null,hidden:false,sidechain:false,compactSummary:false,blocks:[{index:0,kind:'text',preview:`Historical message ${i}`,sourceBytes:20,decodedBytes:20,bodyAvailable:true}],totalBlocks:1,nextBlockCursor:null,diagnostics:[],totalDiagnostics:0})
const page=(start:number,count:number,nextCursor:number|null)=>({progress:{source:'claude-code',writtenItems:11},sourceSessionId:'foreign-session',title:'Original task',items:Array.from({length:count},(_,i)=>({position:start+i,sourceIndex:0,sourceSessionId:'foreign-session',record:record(start+i)})),nextCursor})
const props={deviceId:'target',workspacePath:'/owned',source:{operationId:'operation',sourceJobId:'archive',viewId:'chosen'},isCurrent:()=>true}
beforeEach(()=>{vi.resetAllMocks();api.branchPage.mockResolvedValueOnce(page(0,10,10)).mockResolvedValue(page(10,1,null))})

test('ordinary chat reads exactly the selected history in bounded inert pages',async()=>{
 render(<ImportedHistoryPanel {...props}/>)
 await screen.findByText('Historical message 0')
 const panel=screen.getByTestId('imported-conversation-history')
 expect(within(panel).getAllByTestId('historical-record')).toHaveLength(10)
 expect(within(panel).getAllByTestId('history-markdown')[0]).toHaveAttribute('data-historical','true')
 expect(screen.queryByRole('button',{name:'continuation.create'})).not.toBeInTheDocument()
 expect(api.branchPage).toHaveBeenLastCalledWith({jobId:'archive',viewId:'chosen',cursor:0},{signal:expect.any(AbortSignal)})
 fireEvent.click(within(panel).getByRole('button',{name:'next'}));await screen.findByText('Historical message 10')
 expect(screen.queryByText('Historical message 0')).not.toBeInTheDocument()
 expect(within(panel).getAllByTestId('historical-record')).toHaveLength(1)
 expect(api.branchPage).toHaveBeenLastCalledWith({jobId:'archive',viewId:'chosen',cursor:10},{signal:expect.any(AbortSignal)})
})

test('unavailable source history reports a readable failure and retries without starting a continuation',async()=>{
 api.branchPage.mockReset().mockRejectedValueOnce(new Error('history_missing')).mockResolvedValue(page(0,1,null))
 render(<ImportedHistoryPanel {...props}/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('conversation_history.unavailable')
 expect(screen.queryByTestId('historical-record')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'refresh'}));await screen.findByText('Historical message 0')
 expect(api.branchPage).toHaveBeenCalledTimes(2)
})

test('identifies reconstructed history without claiming an exact provider context',async()=>{
 api.branchPage.mockReset().mockResolvedValue({...page(0,1,null),progress:{...page(0,1,null).progress,issues:['codex_readable_reconstruction_requires_admission']}})
 render(<ImportedHistoryPanel {...props}/>)
 await screen.findByText('Historical message 0')
 expect(screen.getByRole('note')).toHaveTextContent('conversation_history.reconstructed')
})
