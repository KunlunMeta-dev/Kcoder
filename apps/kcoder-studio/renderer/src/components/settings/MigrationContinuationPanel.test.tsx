import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {MigrationContinuationPanel} from './MigrationContinuationPanel'
const {model,navigate,refreshWork}=vi.hoisted(()=>({model:{result:null as unknown,busy:false,error:'',create:vi.fn(),resume:vi.fn(),cancel:vi.fn(),refresh:vi.fn()},navigate:vi.fn(),refreshWork:vi.fn().mockResolvedValue(undefined)}))
vi.mock('@/kcoder/useMigrationContinuation',()=>({useMigrationContinuation:()=>model}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('@/features/workbench/useWorkbench',()=>({useWorkbench:()=>({openRuntimeTask:navigate,refreshWorkLists:refreshWork})}))
const props={deviceId:'target',workspacePath:'/owned',sourceJobId:'source',viewId:'view',isCurrent:()=>true}
beforeEach(()=>{vi.clearAllMocks();model.result=null;model.busy=false;model.error=''})
test('creation requires an explicit click and retains the chosen new-session identity',()=>{
  render(<MigrationContinuationPanel {...props}/>);expect(model.create).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'kworker'}});fireEvent.click(screen.getByRole('button',{name:'continuation.create'}));expect(model.create).toHaveBeenCalledExactlyOnceWith('kworker')
})
test('opening a saved session refreshes the list and selects the actual workspace without sending a prompt',async()=>{
  model.result={job:{stage:'imported',threadId:'Ab123',compilation:null,projection:null},workerRunning:false}
  render(<MigrationContinuationPanel {...props}/>);fireEvent.click(screen.getByRole('button',{name:'continuation.open'}));await waitFor(()=>expect(navigate).toHaveBeenCalledExactlyOnceWith({deviceId:'target',taskId:'kcoder:target:Ab123',workspacePath:'/owned'}));expect(refreshWork).toHaveBeenCalledOnce();expect(model.resume).not.toHaveBeenCalled();expect(model.create).not.toHaveBeenCalled()
})
test('blocked diagnostics use ten-item pages and do not masquerade as a saved session',()=>{
  model.result={job:{stage:'blocked',threadId:null,projection:null,compilation:{issues:Array.from({length:12},(_,index)=>({code:`issue_${index}`,position:index,blockIndex:0}))}},workerRunning:false}
  render(<MigrationContinuationPanel {...props}/>);fireEvent.click(screen.getByText('continuation.issues'));expect(screen.getAllByRole('listitem')).toHaveLength(10);expect(screen.queryByRole('button',{name:'continuation.open'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'next'}));expect(screen.getAllByRole('listitem')).toHaveLength(2)
})
