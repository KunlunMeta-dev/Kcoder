import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskCapabilityScopeRecords } from './TaskCapabilityScopeRecords'
import type { IntegrationRequest, IntegrationTaskCapabilityScopeSnapshot } from '../../../../../shared/generated/contracts'
const f=vi.hoisted(()=>({request:vi.fn(),current:()=>true}))
vi.mock('@/host/localExecutor',()=>({requestLocalExecutor:f.request}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string,values?:Record<string,unknown>)=>values?.id?`${key} ${values.id}`:key,i18n:{language:'en'}})}))
vi.mock('@/kcoder/usePluginTargetScope',()=>({usePluginTargetScope:(target:string)=>({key:target,isCurrent:f.current})}))
const target={serverId:'native',workspacePath:'/owned'},scope={accountId:'owner',targetId:'native-target',workspaceId:'workspace',identityGeneration:'1',targetRevision:'1'}
const original={initialAttempt:{threadId:'original-thread',turnId:'original-turn',attemptId:'original-attempt'},runtimeOperationId:'original-operation'}
const saved:IntegrationTaskCapabilityScopeSnapshot={threadId:'original-thread',revision:3,selection:{mode:'selected',sources:[{sourceRef:{id:'original-connector',revision:'fixed-r1'},accountRef:null}]},effectiveSources:[{sourceRef:{id:'original-connector',revision:'fixed-r1'},accountRef:null}],effectiveFrom:'next_tool_boundary'}
const directory={entries:[{referenceId:'original-binding',target:original,savedSnapshot:saved,observationState:'saved_only',reasonCode:null}],nextCursor:null,observationState:'saved_only',reasonCode:null}
function reply(request:IntegrationRequest,result:unknown){return {contractVersion:'parallel-v1',requestId:request.requestId,operationId:null,entityRevision:null,status:'completed',observedAt:'2026-10-25T00:00:00Z',result,error:null}}
function install(readCurrent:()=>Promise<unknown>=async()=>({...saved,revision:4,effectiveFrom:'current_snapshot'})){
  f.request.mockImplementation(async(_method,params)=>{
    if(params.method==='integrations/scope/read')return scope
    if(params.method==='integrations/tasks/readSavedTaskSourceBindings')return reply(params.params,directory)
    if(params.method==='integrations/tasks/readTaskSources')return reply(params.params,await readCurrent())
    throw new Error('Unexpected latest selection, mutation, task creation or resume')
  })
}
afterEach(()=>{cleanup();f.request.mockReset()})
test('opening records never chooses first/latest; the exact explicit tuple reads current while saved_only stays distinct',async()=>{
  install();render(<TaskCapabilityScopeRecords target={target} threadId="original-thread"/> )
  const button=await screen.findByRole('button',{name:/original-turn/})
  expect(f.request.mock.calls.filter(([,params])=>params.method==='integrations/tasks/readTaskSources')).toHaveLength(0)
  fireEvent.click(button)
  await waitFor(()=>expect(screen.getByTestId('task-capability-scope-selected-record')).toHaveAttribute('data-state','current'))
  expect(screen.getByText('savedOnly')).toBeInTheDocument()
  expect(f.request).toHaveBeenCalledWith('runtime.integrations.request',expect.objectContaining({method:'integrations/tasks/readTaskSources',params:expect.objectContaining({payload:{target:original,params:{threadId:'original-thread'}}})}),{signal:expect.any(AbortSignal)})
  expect(screen.getAllByTestId('task-capability-scope-readonly-snapshot')).toHaveLength(2)
  expect(screen.queryByRole('radio')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button',{name:/Save task tools and resource scope/})).toBeNull()
  expect(f.request.mock.calls.every(([,params])=>!Object.hasOwn(params.params??{},'operationId'))).toBe(true)
})
test('nonresident current lookup failure retains the saved source revision without claiming active authority',async()=>{
  install(async()=>{throw new Error('TASK_CAPABILITY_SCOPE_RESIDENT_OWNER_REQUIRED')})
  render(<TaskCapabilityScopeRecords target={target} threadId="original-thread"/> )
  fireEvent.click(await screen.findByRole('button',{name:/original-turn/}))
  await waitFor(()=>expect(screen.getByTestId('task-capability-scope-selected-record')).toHaveAttribute('data-state','unknown'))
  expect(screen.getByText('currentUnknown')).toBeInTheDocument();expect(screen.getByText('savedOnly')).toBeInTheDocument()
  expect(screen.getAllByTestId('task-capability-scope-readonly-snapshot')).toHaveLength(1)
  expect(screen.getAllByText('original-connector').length).toBeGreaterThan(0)
})
test('late original binding cannot display current sources after target change',async()=>{
  let finish!:(value:unknown)=>void;install(()=>new Promise(resolve=>{finish=resolve}))
  const view=render(<TaskCapabilityScopeRecords target={target} threadId="original-thread"/> )
  fireEvent.click(await screen.findByRole('button',{name:/original-turn/}));await waitFor(()=>expect(finish).toBeTypeOf('function'))
  view.rerender(<TaskCapabilityScopeRecords target={{serverId:'other',workspacePath:'/owned'}} threadId="original-thread"/> )
  await act(async()=>finish({...saved,revision:8}))
  expect(screen.queryByTestId('task-capability-scope-selected-record')).toBeNull()
})

test('emits an exact aggregate selector only after explicit metadata-backed choose and clears it on cancel',async()=>{
  let finish!:(value:unknown)=>void
  install(()=>new Promise(resolve=>{finish=resolve}))
  const selected=vi.fn()
  render(<TaskCapabilityScopeRecords target={target} threadId="original-thread" onSelectedTarget={selected}/> )
  const choice=await screen.findByRole('button',{name:/original-turn/})
  expect(selected).not.toHaveBeenCalled()
  fireEvent.click(choice)
  await waitFor(()=>expect(selected).toHaveBeenCalledWith(original))
  expect(selected).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button',{name:'cancel'}))
  expect(selected).toHaveBeenLastCalledWith(undefined)
  await act(async()=>finish({...saved,revision:9}))
  expect(selected).toHaveBeenCalledTimes(2)
})
