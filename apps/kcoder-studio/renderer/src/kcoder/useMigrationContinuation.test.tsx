import {act,renderHook,waitFor} from '@testing-library/react'
import {beforeEach,expect,test,vi} from 'vitest'
import {useMigrationContinuation} from './useMigrationContinuation'
import {notifyAccountContextChange} from './accountContextEvents'
const {api}=vi.hoisted(()=>({api:Object.fromEntries(['continuationCreate','continuationRead','continuationRun','continuationResume','continuationCancel'].map(name=>[name,vi.fn()]))}))
vi.mock('./gatewayMigration',()=>({createMigrationApi:()=>api}))
const planned={job:{jobId:'job',sourceJobId:'source',viewId:'view',sequence:0,stage:'planned',cancelRevision:0,cancelRequested:false,threadId:null,options:{studioWorkMode:'kcoder'}},workerRunning:false,workerError:null}
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();api.continuationCreate.mockImplementation(params=>Promise.resolve({...planned,job:{...planned.job,jobId:params.requestId}}));api.continuationRun.mockImplementation(params=>Promise.resolve({...planned,job:{...planned.job,jobId:params.jobId,sequence:1,stage:'preparing'},workerRunning:true}))})

test('a stable request is chosen before create and a new user action starts one native job',async()=>{
  const {result}=renderHook(()=>useMigrationContinuation('target','/owned','source','view',()=>true))
  expect(api.continuationCreate).not.toHaveBeenCalled();expect(api.continuationRun).not.toHaveBeenCalled()
  await act(()=>result.current.create('kworker'))
  const id=api.continuationCreate.mock.calls[0][0].requestId
  expect(api.continuationCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestId:id,options:expect.objectContaining({studioWorkMode:'kworker'})}))
  expect(api.continuationRun).toHaveBeenCalledExactlyOnceWith({jobId:id,expectedSequence:0})
})

test('a lost create reply is observed without automatically running or reminting the request',async()=>{
  api.continuationCreate.mockRejectedValue(new Error('connection lost'));api.continuationRead.mockImplementation(params=>Promise.resolve({...planned,job:{...planned.job,jobId:params.jobId}}))
  const {result,unmount}=renderHook(()=>useMigrationContinuation('target','/owned','source','view',()=>true));await act(()=>result.current.create('kcoder'))
  expect(api.continuationRun).not.toHaveBeenCalled();const id=result.current.result?.job.jobId;expect(id).toBeTruthy();unmount()
  const second=renderHook(()=>useMigrationContinuation('target','/owned','source','view',()=>true));await waitFor(()=>expect(second.result.current.result?.job.jobId).toBe(id));expect(api.continuationCreate).toHaveBeenCalledOnce()
})

test('late replies cannot cross a changed target or account context',async()=>{
  let finish!:(value:unknown)=>void;api.continuationCreate.mockReturnValue(new Promise(resolve=>{finish=resolve}))
  const {result,rerender}=renderHook(({device})=>useMigrationContinuation(device,'/owned','source','view',()=>true),{initialProps:{device:'first'}})
  let pending!:Promise<boolean>;act(()=>{pending=result.current.create('kcoder')});await waitFor(()=>expect(api.continuationCreate).toHaveBeenCalledOnce())
  rerender({device:'second'});await act(async()=>{finish(planned);await pending});expect(result.current.result).toBeNull();expect(api.continuationRun).not.toHaveBeenCalled()
  api.continuationCreate.mockResolvedValue(planned);notifyAccountContextChange('second');await act(()=>result.current.create('kcoder'));expect(api.continuationCreate).toHaveBeenCalledOnce()
})

test('stale observations do not regress a newer checkpoint',async()=>{
  api.continuationRun.mockResolvedValue({...planned,job:{...planned.job,sequence:9,stage:'imported',threadId:'Ab123'}})
  const {result}=renderHook(()=>useMigrationContinuation('target','/owned','source','view',()=>true));await act(()=>result.current.create('kcoder'))
  api.continuationRead.mockResolvedValue(planned);await act(()=>result.current.refresh());expect(result.current.result?.job.stage).toBe('imported')
})
