import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '../../accountContextEvents'
import type { GatewayRuntimeCore } from './core'
import { getTaskGoalObservation } from './goalObservation'
import { RUNTIME_GOAL_SCOPE_RETIRED } from '../../goalObservationCancellation'

function context() {
  const server={id:'goal-observation-native',transport:'local',command:'/owned/kcoder',workspacePath:'/owned'}
  let closed=0
  const request=vi.fn()
  const core={disposed:false,compatibility:{isRuntimeTaskId:()=>true},canonicalTaskByRequested:new Map(),
    taskDescriptor:vi.fn(async()=>({taskId:'original',task:{threadId:'thread',workspacePath:'/owned'},server})),
    serverForParams:vi.fn(async()=>({...server})),
    withTransientClient:async(_server:unknown,read:(client:{request:typeof request})=>Promise<unknown>)=>{try{return await read({request})}finally{closed++}},
  } as unknown as GatewayRuntimeCore
  return {core,request,server,closed:()=>closed,params:{address:{deviceId:server.id,taskId:'original',threadId:'thread',workspacePath:'/owned'}}}
}
test('actual Goal read signal reaches the owned transient request and abort settles its owner', async () => {
  const f=context(), abort=new AbortController()
  let entered!:(value?:unknown)=>void
  const ready=new Promise(resolve=>{entered=resolve})
  f.request.mockImplementation((_method,_params,options)=>new Promise((_resolve,reject)=>{entered();options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})}))
  const pending=getTaskGoalObservation.call(f.core,f.params,{signal:abort.signal})
  await ready;abort.abort()
  await expect(pending).rejects.toMatchObject({name:'AbortError'})
  expect(f.closed()).toBe(1)
  expect(f.request).toHaveBeenCalledWith('thread/goal/get',{threadId:'thread'},{signal:abort.signal})
})
test('account or configuration change cannot return a late old-profile Goal', async () => {
  for(const invalidate of ['account','configuration']) {
    const f=context();let release!:(value:unknown)=>void,entered!:()=>void
    const ready=new Promise<void>(resolve=>{entered=resolve})
    f.request.mockImplementation(()=>new Promise(resolve=>{release=resolve;entered()}))
    const pending=getTaskGoalObservation.call(f.core,f.params)
    await ready
    if(invalidate==='account')notifyAccountContextChange(f.server.id)
    else f.server.workspacePath='/changed'
    release({goal:{threadId:'thread'}})
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: RUNTIME_GOAL_SCOPE_RETIRED })
    expect(f.closed()).toBe(1);expect(f.request).toHaveBeenCalledTimes(1)
  }
})
test('already-cancelled reads do not connect or resolve another original task', async () => {
  const f=context(),abort=new AbortController();abort.abort()
  await expect(getTaskGoalObservation.call(f.core,f.params,{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'})
  expect(f.core.taskDescriptor).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled()
})
