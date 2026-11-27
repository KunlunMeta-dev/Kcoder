import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceAdoptionPrepareParams, MigrationSourceAdoptionResult, MigrationSourceReceivedResult } from '../../../../shared/generated/contracts'

const model=vi.hoisted(()=>({busy:false,error:null,page:null as MigrationSourceReceivedResult|null,pageIndex:0,selected:[],input:null as MigrationSourceAdoptionPrepareParams|null,
  result:null as MigrationSourceAdoptionResult|null,records:[] as MigrationSourceAdoptionPrepareParams[],pollingPaused:false,canPrepare:false,
  load:vi.fn(),select:vi.fn(),map:vi.fn(),prepare:vi.fn(),read:vi.fn(),operate:vi.fn(async()=>{})}))
vi.mock('@/kcoder/useMigrationSourceAdoption',()=>({useMigrationSourceAdoption:()=>model}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
const target:GatewayServer={id:'target',label:'Target',description:'',transport:'local',runtime:'kcoder'}
const requestId='11111111-1111-4111-8111-111111111111',adoptionId='22222222-2222-4222-8222-222222222222'
const receipt={requestId,manifestSha256:'a'.repeat(64),entries:3,bytes:30}
const input:MigrationSourceAdoptionPrepareParams={locator:{requestId,adoptionId,target:{sessionId:requestId,purpose:'target_recovery',targetId:'target'}},manifestSha256:receipt.manifestSha256,selections:[{entryId:'e0000-0000'}]}
const state={requestId,adoptionId,phase:'cancelled' as const,completedSources:0,totalSources:1,blockedItems:0,workerState:'stopped' as const,control:{sequence:1,cancelWatermark:1},cancelRequested:true,errorCode:null,jobs:[]}
const current=()=>true
beforeEach(()=>{vi.clearAllMocks();Object.assign(model,{busy:false,error:null,page:null,pageIndex:0,selected:[],input:null,result:null,records:[],pollingPaused:false,canPrepare:false})})
it('reads only after an explicit click, requires project mapping and treats history projects as provenance',()=>{
  model.page={receipt,totalSources:3,nextPage:null,items:['configuration','work_asset','history'].map((kind,index)=>({entryId:`e000${index}-0000`,class:kind as 'configuration'|'work_asset'|'history',source:'codex',category:null,projectScoped:true,files:1,bytes:10}))}
  render(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={current}/>)
  expect(model.load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-adoption-expand'))
  expect(model.load).toHaveBeenCalledOnce()
  expect(screen.getAllByTestId('migration-adoption-received-row')).toHaveLength(3)
  expect(screen.getByTestId('migration-adoption-map-e0000-0000')).toBeDisabled()
  expect(screen.getByTestId('migration-adoption-map-e0001-0000')).toBeDisabled()
  expect(screen.queryByTestId('migration-adoption-map-e0002-0000')).toBeNull()
  expect(screen.getByText('adoption.history_provenance')).toBeTruthy()
  expect(screen.getByTestId('migration-adoption-prepare')).toBeDisabled()
})
it('keeps unknown/untracked execution explicit and does not offer resume with null control',()=>{
  model.input=input;model.result={state:{...state,phase:'unknown',workerState:'unknown',control:null,cancelRequested:null}}
  render(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={current}/>)
  fireEvent.click(screen.getByTestId('migration-adoption-expand'))
  expect(screen.getByText('adoption.worker_unknown')).toBeTruthy()
  expect(screen.getByText('adoption.control_unknown')).toBeTruthy()
  expect(screen.queryByTestId('migration-adoption-resume')).toBeNull()
  expect(screen.queryByTestId('migration-adoption-cancel')).toBeNull()
  expect(model.operate).not.toHaveBeenCalled()
})
it('opens only a ready normal batch preview and never calls a save operation',()=>{
  model.input=input;model.result={state:{...state,phase:'preview_ready',jobs:[{jobId:`mig-${'b'.repeat(32)}`,source:'codex',previewReady:true,targetScope:'user'}]}}
  const open=vi.fn(),view=render(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={current} onOpenBatch={open}/>)
  fireEvent.click(screen.getByTestId('migration-adoption-expand'))
  expect(screen.getByText('adoption.phase_preview_ready')).toBeTruthy()
  fireEvent.click(screen.getByTestId(`migration-adoption-open-mig-${'b'.repeat(32)}`))
  expect(open).toHaveBeenCalledWith(`mig-${'b'.repeat(32)}`)
  expect(model.operate).not.toHaveBeenCalled()
  view.rerender(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={()=>false} onOpenBatch={open}/>)
  fireEvent.click(screen.getByTestId(`migration-adoption-open-mig-${'b'.repeat(32)}`))
  expect(open).toHaveBeenCalledTimes(1)
})
it('invalidates a resume confirmation when the original control sequence advances',()=>{
  model.input=input;model.result={state}
  const view=render(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={current}/>)
  fireEvent.click(screen.getByTestId('migration-adoption-expand'))
  fireEvent.click(screen.getByTestId('migration-adoption-resume'))
  fireEvent.change(screen.getByTestId('migration-adoption-confirm-input'),{target:{value:'RESUME'}})
  model.result={state:{...state,control:{sequence:2,cancelWatermark:1}}}
  view.rerender(<MigrationSourceAdoptionPanel target={target} receipt={receipt} isCurrent={current}/>)
  expect(screen.queryByTestId('migration-adoption-confirm-submit')).toBeNull()
  expect(model.operate).not.toHaveBeenCalled()
})
