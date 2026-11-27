import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {MigrationBranchTools} from './MigrationBranchTools'
const {api}=vi.hoisted(()=>({api:{branchToolsRead:vi.fn(),branchToolsPage:vi.fn()}}))
vi.mock('@/kcoder/gatewayMigration',()=>({createMigrationApi:()=>api}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
beforeEach(()=>{vi.resetAllMocks();api.branchToolsRead.mockResolvedValue({state:{viewId:'view',run:{sequence:5,stage:'ready',failureCode:null},progress:{processedRecords:20,recordedLinks:12,unresolvedLinks:0,sealed:true},workerRunning:false,cancelRequested:false},workerError:null})})

test('a recorded result remains unknown in the UI and tools list uses the backend cursor',async()=>{
  const link={id:'link',callId:'call',name:'write',namespace:'tools',sourceTurnId:null,call:{sequence:0,record:3,block:0,sourceIndex:1},result:{sequence:1,record:1,block:0,replacementIndex:2},executionEvent:null,executionOutcome:null,status:'linked',outcome:'recorded_result'}
  api.branchToolsPage.mockResolvedValue({links:[link],nextCursor:'next-page',progress:{processedRecords:20,recordedLinks:12,unresolvedLinks:0,sealed:true}})
  render(<MigrationBranchTools deviceId="target" jobId="job" viewId="view" isCurrent={()=>true}/>)
  await screen.findByText('branch_tools.stages.ready')
  fireEvent.click(screen.getByRole('button',{name:'branch_tools.inspect'}))
  await screen.findByText(/transcript.outcomes.recorded_result/)
  expect(screen.queryByText(/transcript.outcomes.recorded_success/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'next'}))
  await waitFor(()=>expect(api.branchToolsPage).toHaveBeenLastCalledWith({jobId:'job',viewId:'view',cursor:'next-page'}))
})
