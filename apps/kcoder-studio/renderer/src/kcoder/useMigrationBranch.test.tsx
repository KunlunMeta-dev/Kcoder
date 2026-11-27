import {act,renderHook,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {useMigrationBranch} from './useMigrationBranch'
const {api}=vi.hoisted(()=>({api:Object.fromEntries(['branchRead','branchPrepare','branchRun','branchResume','branchCancel','historyJobs'].map(name=>[name,vi.fn()]))}))
vi.mock('./gatewayMigration',()=>({createMigrationApi:()=>api}))
const progress={viewId:'view',sequence:1,source:'codex',stage:'planned',checks:0,writtenItems:0,totalItems:null,structuralComplete:null,sourceRecordsWithDiagnostics:0,issues:[],cancelRequested:false,failureCode:null}
const planned={choice:{viewId:'view',relatedJobIds:[]},progress,workerRunning:false,workerError:null}
const empty={choice:null,progress:null,workerRunning:false,workerError:null}
beforeEach(()=>{vi.resetAllMocks();api.branchRead.mockResolvedValue(empty);api.branchPrepare.mockResolvedValue(planned);api.branchRun.mockResolvedValue({...planned,workerRunning:true})})

test('branch computation begins only after an explicit prepare and retains selected parent identities',async()=>{
  const {result}=renderHook(()=>useMigrationBranch('target','/owned','job',()=>true,true))
  await waitFor(()=>expect(result.current.available).toBe(true))
  expect(api.branchPrepare).not.toHaveBeenCalled();expect(api.branchRun).not.toHaveBeenCalled()
  act(()=>result.current.setRelated(['parent']))
  api.branchPrepare.mockResolvedValue({...planned,choice:{viewId:'view',relatedJobIds:['parent']}})
  await act(()=>result.current.prepare())
  expect(api.branchPrepare).toHaveBeenCalledExactlyOnceWith({jobId:'job',relatedJobIds:['parent']})
  expect(api.branchRun).toHaveBeenCalledExactlyOnceWith({jobId:'job',viewId:'view'})
})

test('a lost prepare reply reconciles matching choices without automatically replaying a run',async()=>{
  const {result}=renderHook(()=>useMigrationBranch('target',undefined,'job',()=>true,true))
  await waitFor(()=>expect(result.current.available).toBe(true))
  api.branchPrepare.mockRejectedValue(new Error('connection lost'));api.branchRead.mockResolvedValue(planned)
  await act(()=>result.current.prepare())
  expect(result.current.state?.progress?.viewId).toBe('view')
  expect(api.branchRun).not.toHaveBeenCalled()
})

test('target lifetime changes prevent a delayed resume receipt from starting another account job',async()=>{
  let current=true;let finish!:(value:unknown)=>void
  api.branchRead.mockResolvedValue({...planned,progress:{...progress,sequence:4,stage:'cancelled'}})
  api.branchResume.mockReturnValue(new Promise(resolve=>{finish=resolve}))
  const {result}=renderHook(()=>useMigrationBranch('target','/owned','job',()=>current,true))
  await waitFor(()=>expect(result.current.state?.progress?.stage).toBe('cancelled'))
  let pending!:Promise<void>;act(()=>{pending=result.current.resume()})
  await waitFor(()=>expect(api.branchResume).toHaveBeenCalledOnce())
  current=false;await act(async()=>{finish(planned);await pending})
  expect(api.branchRun).not.toHaveBeenCalled()
})

test('older sequences do not overwrite a ready branch and parent edits invalidate its displayed view',async()=>{
  const ready={...planned,progress:{...progress,sequence:8,stage:'ready',totalItems:2,structuralComplete:true}}
  api.branchRead.mockResolvedValue(ready)
  const {result}=renderHook(()=>useMigrationBranch('target',undefined,'job',()=>true,true))
  await waitFor(()=>expect(result.current.readyViewId).toBe('view'))
  api.branchRead.mockResolvedValue(planned);await act(()=>result.current.refresh())
  expect(result.current.readyViewId).toBe('view')
  act(()=>result.current.setRelated(['new-parent']))
  expect(result.current.dirty).toBe(true);expect(result.current.readyViewId).toBeUndefined()
})

test('an initially busy catalog is reread without starting a branch mutation',async()=>{
  const ready={...planned,progress:{...progress,sequence:8,stage:'ready',structuralComplete:true}}
  api.branchRead.mockRejectedValueOnce(new Error('history_catalog_busy')).mockResolvedValue(ready)
  const {result}=renderHook(()=>useMigrationBranch('target','/owned','job',()=>true,true))
  await waitFor(()=>expect(result.current.readyViewId).toBe('view'),{timeout:2500})
  expect(result.current.error).toBe('')
  expect(api.branchRead).toHaveBeenCalledTimes(2)
  expect(api.branchPrepare).not.toHaveBeenCalled();expect(api.branchRun).not.toHaveBeenCalled()
})

test('a busy progress read retains its checkpoint and continues to the ready branch',async()=>{
  const active={...planned,workerRunning:true}
  const ready={...planned,progress:{...progress,sequence:8,stage:'ready',structuralComplete:true}}
  api.branchRead.mockResolvedValueOnce(active).mockRejectedValueOnce(new Error('history_catalog_busy')).mockResolvedValue(ready)
  const {result}=renderHook(()=>useMigrationBranch('target','/owned','job',()=>true,true))
  await waitFor(()=>expect(api.branchRead).toHaveBeenCalledTimes(2))
  expect(result.current.error).toBe('');expect(result.current.state?.progress?.sequence).toBe(1)
  await waitFor(()=>expect(result.current.readyViewId).toBe('view'),{timeout:2500})
  expect(api.branchRun).not.toHaveBeenCalled()
})

test('persistent busy reads stop at the bound and ownership loss prevents a scheduled retry',async()=>{
  api.branchRead.mockResolvedValueOnce({...planned,workerRunning:true}).mockRejectedValue(new Error('history_catalog_busy'))
  const first=renderHook(()=>useMigrationBranch('target','/owned','job',()=>true,true))
  await waitFor(()=>expect(first.result.current.error).toBe('history_catalog_busy'),{timeout:3000})
  expect(api.branchRead).toHaveBeenCalledTimes(5)
  expect(first.result.current.state?.progress?.sequence).toBe(1)
  first.unmount();api.branchRead.mockReset()
  let current=true
  api.branchRead.mockResolvedValueOnce({...planned,workerRunning:true}).mockRejectedValue(new Error('history_catalog_busy'))
  const second=renderHook(()=>useMigrationBranch('target','/owned','job',()=>current,true))
  await waitFor(()=>expect(api.branchRead).toHaveBeenCalledTimes(2))
  current=false
  await new Promise(resolve=>setTimeout(resolve,400))
  expect(api.branchRead).toHaveBeenCalledTimes(2)
  expect(second.result.current.error).toBe('')
  expect(api.branchRun).not.toHaveBeenCalled()
})
