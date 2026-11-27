import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from '../../accountContextEvents'
import type { GatewayRuntimeCore } from './core'
import { getTaskGoalObservation } from './goalObservation'
import { RUNTIME_GOAL_SCOPE_RETIRED } from '../../goalObservationCancellation'
import type { GatewayClient, OwnedGatewayConnection } from '../../gatewayRuntimeTypes'
import type { GatewayServer } from '../../gatewayRpc'

function context() {
  const server:GatewayServer={id:'goal-observation-native',label:'Owned Goal',description:'',runtime:'kcoder',transport:'local',command:'/owned/kcoder',workspacePath:'/owned'}
  let closed=0
  const request=vi.fn()
  const task={serverId:server.id,threadId:'thread',workspacePath:'/owned'}
  const core={disposed:false,compatibility:{isRuntimeTaskId:()=>true},canonicalTaskByRequested:new Map(),
    tasks:new Map([['original',task]]),clientByTask:new Map(),connectionsByClient:new Map(),
    disconnectRecoveryByTask:new Map(),appServerDisconnectedClients:new Set(),
    isRestartingServer:vi.fn(()=>false),
    taskDescriptor:vi.fn(async()=>({taskId:'original',task,server})),
    serverForParams:vi.fn(async()=>({...server})),
    withTransientClient:async(_server:unknown,read:(client:{request:typeof request})=>Promise<unknown>)=>{try{return await read({request})}finally{closed++}},
  } as unknown as GatewayRuntimeCore
  core.withWorkspaceReadClient = (server, read, path, scanBound) => core.withTransientClient(server, read, path, scanBound)
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

test.each(['before-dispatch','reading','final-target-check'].flatMap(phase =>
  ['removed','target','thread','workspace'].map(change => ({phase,change}))))(
  'the original-task owner fences a $change change during $phase on the cold Goal path',async({phase,change})=>{
    const f=context()
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const entered=vi.fn()
    f.request.mockResolvedValue({goal:{status:'active'}})
    if(phase==='reading')f.request.mockImplementationOnce(async()=>{entered();await gate;return {goal:{status:'active'}}})
    else {
      if(phase==='final-target-check')vi.mocked(f.core.serverForParams).mockResolvedValueOnce(f.server)
      vi.mocked(f.core.serverForParams).mockImplementationOnce(async()=>{entered();await gate;return {...f.server}})
    }
    const pending=getTaskGoalObservation.call(f.core,f.params)
    const settled=pending.catch(error=>error)
    try {
      await vi.waitFor(()=>expect(entered).toHaveBeenCalledOnce())
      const original=f.core.tasks.get('original')!
      if(change==='removed')f.core.tasks.delete('original')
      else f.core.tasks.set('original',{...original,
        ...(change==='target'?{serverId:'replacement'}:change==='thread'?{threadId:'replacement'}:{workspacePath:'/replacement'})})
      release()
      await expect(settled).resolves.toMatchObject({name:'AbortError',code:RUNTIME_GOAL_SCOPE_RETIRED})
      expect(f.request).toHaveBeenCalledTimes(phase==='before-dispatch'?0:1)
      expect(f.closed()).toBe(phase==='before-dispatch'?0:1)
    } finally {release();await settled}
  })

function residentContext() {
  const f=context()
  const bound=vi.fn().mockResolvedValue({goal:{status:'active'}})
  const diagnostic={targetId:f.server.id,connectionId:'original-connection'}
  const client={request:vi.fn(),requestOnConnection:bound,close:vi.fn(),diagnosticConnection:diagnostic} as unknown as GatewayClient
  const connection={client,server:f.server,serverId:f.server.id,channel:'runtime',workspacePath:'/owned',nativeManagementOnly:false} as OwnedGatewayConnection
  f.core.clientByTask.set('original',client)
  f.core.connectionsByClient.set(client,connection)
  f.request.mockResolvedValue({goal:null})
  return {...f,bound,client,connection,diagnostic}
}

test('Goal observation borrows only the original resident connection without acquiring or closing it', async () => {
  const f=residentContext(),abort=new AbortController()
  await expect(getTaskGoalObservation.call(f.core,f.params,{signal:abort.signal})).resolves.toMatchObject({accepted:true,goal:{status:'active'}})
  expect(f.bound).toHaveBeenCalledExactlyOnceWith('original-connection','thread/goal/get',{threadId:'thread'},{signal:abort.signal})
  expect(f.request).not.toHaveBeenCalled();expect(f.closed()).toBe(0)
  expect(f.client.request).not.toHaveBeenCalled();expect(f.client.close).not.toHaveBeenCalled()
})

test('cancelling a borrowed read does not close the original task connection', async () => {
  const f=residentContext(),abort=new AbortController()
  let entered!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve})
  f.bound.mockImplementationOnce((_connection,_method,_params,options)=>new Promise((_resolve,reject)=>{
    entered();options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})
  }))
  const pending=getTaskGoalObservation.call(f.core,f.params,{signal:abort.signal})
  await ready;abort.abort()
  await expect(pending).rejects.toMatchObject({name:'AbortError'})
  expect(f.client.close).not.toHaveBeenCalled();expect(f.closed()).toBe(0)
})

test.each(['account','configuration','client','thread','workspace','connection-generation','recovery'] as const)(
  'a late borrowed Goal is retired after %s changes',async change=>{
    const f=residentContext()
    let release!:(value:unknown)=>void,entered!:()=>void
    const ready=new Promise<void>(resolve=>{entered=resolve})
    f.bound.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered()}))
    const pending=getTaskGoalObservation.call(f.core,f.params)
    await ready
    if(change==='account')notifyAccountContextChange(f.server.id)
    else if(change==='configuration')Object.assign(f.server,{profile:'replaced-profile'})
    else if(change==='client')f.core.clientByTask.delete('original')
    else if(change==='thread')f.core.tasks.get('original')!.threadId='another-thread'
    else if(change==='workspace')f.core.tasks.get('original')!.workspacePath='/another-workspace'
    else if(change==='connection-generation')f.diagnostic.connectionId='replacement-connection'
    else f.core.disconnectRecoveryByTask.set('original',Promise.resolve())
    release({goal:{status:'active'}})
    await expect(pending).rejects.toMatchObject({name:'AbortError',code:RUNTIME_GOAL_SCOPE_RETIRED})
    expect(f.bound).toHaveBeenCalledTimes(1);expect(f.request).not.toHaveBeenCalled()
    expect(f.client.close).not.toHaveBeenCalled()
  })

test.each(['workspace','target','profile','browser-channel','management-channel','disconnected','recovery','unbound-client'] as const)(
  'an ineligible %s connection keeps the original cold read path',async mismatch=>{
    const f=residentContext()
    if(mismatch==='workspace')f.connection.workspacePath='/another-workspace'
    else if(mismatch==='target')f.connection.serverId='another-target'
    else if(mismatch==='profile')f.connection.server={...f.connection.server,profile:'other-profile'}
    else if(mismatch==='browser-channel')f.connection.channel='browser'
    else if(mismatch==='management-channel')f.connection.nativeManagementOnly=true
    else if(mismatch==='disconnected')f.core.appServerDisconnectedClients.add(f.client)
    else if(mismatch==='recovery')f.core.disconnectRecoveryByTask.set('original',Promise.resolve())
    else f.client.requestOnConnection=undefined
    await expect(getTaskGoalObservation.call(f.core,f.params)).resolves.toMatchObject({accepted:true,goal:null})
    expect(f.bound).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledExactlyOnceWith('thread/goal/get',{threadId:'thread'})
    expect(f.closed()).toBe(1);expect(f.client.close).not.toHaveBeenCalled()
  })

test('a connection replaced during the final target check cannot publish its late Goal',async()=>{
  const f=residentContext()
  let release!:(value:GatewayServer)=>void,entered!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve})
  vi.mocked(f.core.serverForParams)
    .mockResolvedValueOnce(f.server)
    .mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered()}))
  const pending=getTaskGoalObservation.call(f.core,f.params)
  await ready;f.core.clientByTask.delete('original');release(f.server)
  await expect(pending).rejects.toMatchObject({name:'AbortError',code:RUNTIME_GOAL_SCOPE_RETIRED})
})
