import {act,renderHook,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {useMigrationBranchTools} from './useMigrationBranchTools'
const {api}=vi.hoisted(()=>({api:Object.fromEntries(['branchToolsRead','branchToolsRun','branchToolsResume','branchToolsCancel','branchToolsPage'].map(name=>[name,vi.fn()]))}))
vi.mock('./gatewayMigration',()=>({createMigrationApi:()=>api}))
const empty={state:{viewId:'view',run:null,progress:null,workerRunning:false,cancelRequested:false},workerError:null}
const progress={processedRecords:2,recordedLinks:1,unresolvedLinks:0,sealed:false}
const active={...empty,state:{...empty.state,run:{sequence:2,stage:'correlating',failureCode:null},progress,workerRunning:true}}
beforeEach(()=>{vi.resetAllMocks();api.branchToolsRead.mockResolvedValue(empty);api.branchToolsRun.mockResolvedValue(active)})

test('tool correlation runs only on explicit request and uses the bound view',async()=>{
  const {result}=renderHook(()=>useMigrationBranchTools('target','/owned','job','view',()=>true))
  await waitFor(()=>expect(result.current.result).toEqual(empty));expect(api.branchToolsRun).not.toHaveBeenCalled()
  await act(()=>result.current.run())
  expect(api.branchToolsRun).toHaveBeenCalledExactlyOnceWith({jobId:'job',viewId:'view'})
  expect(result.current.result?.state.workerRunning).toBe(true)
})

test('a lost run receipt observes the same view without automatically replaying execution',async()=>{
  const {result}=renderHook(()=>useMigrationBranchTools('target',undefined,'job','view',()=>true))
  await waitFor(()=>expect(result.current.result).toEqual(empty))
  api.branchToolsRun.mockRejectedValue(new Error('connection lost'));api.branchToolsRead.mockResolvedValue(active)
  await act(()=>result.current.run())
  expect(api.branchToolsRun).toHaveBeenCalledOnce();expect(result.current.result?.state.run?.stage).toBe('correlating')
  expect(api.branchToolsRead).toHaveBeenLastCalledWith({jobId:'job',viewId:'view'})
})

test('busy tool-link observations resume polling without repeating the writer',async()=>{
  const ready={...active,state:{...active.state,run:{...active.state.run,sequence:3,stage:'ready'},workerRunning:false}}
  api.branchToolsRead.mockResolvedValueOnce(active).mockRejectedValueOnce(new Error('history_catalog_busy')).mockResolvedValue(ready)
  const {result}=renderHook(()=>useMigrationBranchTools('target','/owned','job','view',()=>true))
  await waitFor(()=>expect(result.current.result?.state.run?.stage).toBe('ready'),{timeout:2500})
  expect(result.current.error).toBe('')
  expect(api.branchToolsRead).toHaveBeenCalledTimes(3)
  expect(api.branchToolsRun).not.toHaveBeenCalled();expect(api.branchToolsResume).not.toHaveBeenCalled()
})

test('initial tool-link catalog contention can recover through a bounded read retry',async()=>{
  api.branchToolsRead.mockRejectedValueOnce(new Error('history_catalog_busy')).mockResolvedValue(empty)
  const {result}=renderHook(()=>useMigrationBranchTools('target','/owned','job','view',()=>true))
  await waitFor(()=>expect(result.current.result).toEqual(empty),{timeout:2500})
  expect(result.current.error).toBe('');expect(api.branchToolsRead).toHaveBeenCalledTimes(2)
  expect(api.branchToolsRun).not.toHaveBeenCalled()
})

test('cancelled work requires its exact persisted run sequence to resume',async()=>{
  api.branchToolsRead.mockResolvedValue({...active,state:{...active.state,workerRunning:false,run:{sequence:7,stage:'cancelled',failureCode:null}}})
  api.branchToolsResume.mockResolvedValue(active)
  const {result}=renderHook(()=>useMigrationBranchTools('target',undefined,'job','view',()=>true))
  await waitFor(()=>expect(result.current.result?.state.run?.stage).toBe('cancelled'))
  await act(()=>result.current.run())
  expect(api.branchToolsResume).toHaveBeenCalledExactlyOnceWith({jobId:'job',viewId:'view',expectedSequence:7})
  expect(api.branchToolsRun).not.toHaveBeenCalled()
})
