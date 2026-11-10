import { afterEach, expect, test } from 'vitest'
import { createTaskCapabilityScopeRecordTransport } from '@/kcoder/taskCapabilityScopeRecordTransport'
import { installTaskWorkspaceGateway, nativeScope, reply } from '../gatewayFixture.test-support'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
const method='integrations/tasks/readTaskSources',target={serverId:'local',workspacePath:'/owned-workspace'}
const selected={initialAttempt:{threadId:'original-thread',turnId:'original-turn',attemptId:'original-attempt'},runtimeOperationId:'original-runtime'}
const snapshot={threadId:'original-thread',revision:4,selection:{mode:'none',sources:[]},effectiveSources:[],effectiveFrom:'current_snapshot'}
const gateways:{dispose():Promise<void>}[]=[]
afterEach(async()=>{await Promise.all(gateways.splice(0).map(gateway=>gateway.dispose()));localStorage.clear()})
test('real LocalExecutor/Gateway retains the explicitly selected native control tuple and no operation mutation',async()=>{
  const gateway=installTaskWorkspaceGateway(async(name,request)=>name==='integrations/scope/read'?nativeScope:reply(request,snapshot),[method]);gateways.push(gateway)
  const transport=createTaskCapabilityScopeRecordTransport(target,()=>true)
  expect(await transport.read(selected,3)).toEqual(snapshot)
  expect(gateway.calls.map(call=>call.method)).toEqual(['integrations/scope/read',method])
  expect(gateway.calls[1].params).toMatchObject({scope:nativeScope,payload:{target:selected,params:{threadId:'original-thread'}}})
  expect(Object.hasOwn(gateway.calls[1].params,'operationId')).toBe(false);transport.dispose()
})
test('foreign thread, rollback or account replacement does not become a current source observation',async()=>{
  for(const variant of ['thread','rollback','account']){
    const gateway=installTaskWorkspaceGateway(async(name,request)=>{
      if(name==='integrations/scope/read')return nativeScope
      if(variant==='account')notifyAccountContextChange('local')
      return reply(request,{...snapshot,...(variant==='thread'?{threadId:'foreign'}:variant==='rollback'?{revision:2}:{})})
    },[method]);gateways.push(gateway)
    const transport=createTaskCapabilityScopeRecordTransport(target,()=>true)
    await expect(transport.read(selected,3)).rejects.toThrow();transport.dispose();await gateway.dispose();gateways.pop()
  }
})
