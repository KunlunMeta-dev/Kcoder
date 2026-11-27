import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import type { TaskWorkspaceTarget } from './taskWorkspaceTransport'
import type { IntegrationRequest, IntegrationTaskCapabilityScopeControlTarget, IntegrationTaskCapabilityScopeSnapshot } from '../../../shared/generated/contracts'
import { isIntegrationReply, isIntegrationScope, isIntegrationTaskCapabilityScopeControlTarget, isIntegrationTaskCapabilityScopeSnapshot } from '../../../shared/generated/contractGuards.mjs'

/** Read one explicitly chosen original tuple; no selection mutation or implicit task restore. */
export function createTaskCapabilityScopeRecordTransport(target:TaskWorkspaceTarget,isCurrent:()=>boolean){
  const owner={...target}, account=captureAccountContextRevision(), pending=new Set<AbortController>()
  let active=true
  const check=()=>{if(!active||!isCurrent()||!account(owner.serverId))throw new Error('TASK_CAPABILITY_SCOPE_RECORD_OWNER_CHANGED')}
  return {
    async read(original:IntegrationTaskCapabilityScopeControlTarget,minimumRevision=0,signal?:AbortSignal):Promise<IntegrationTaskCapabilityScopeSnapshot>{
      check()
      if(!isIntegrationTaskCapabilityScopeControlTarget(original)||!Number.isSafeInteger(minimumRevision)||minimumRevision<0)throw new Error('TASK_CAPABILITY_SCOPE_RECORD_INVALID_REFERENCE')
      const selected=structuredClone(original),abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();pending.add(abort)
      try{
        abort.signal.throwIfAborted()
        const scope=await requestLocalExecutor<unknown>('runtime.integrations.request',{...owner,method:'integrations/scope/read',params:{}},{signal:abort.signal})
        check();abort.signal.throwIfAborted()
        if(!isIntegrationScope(scope))throw new Error('TASK_CAPABILITY_SCOPE_RECORD_INVALID_REPLY')
        const request:IntegrationRequest={contractVersion:'parallel-v1',requestId:createRandomUuid(),scope,timeoutMs:15000,payload:{target:selected,params:{threadId:selected.initialAttempt.threadId}}}
        const reply=await requestLocalExecutor<unknown>('runtime.integrations.request',{...owner,method:'integrations/tasks/readTaskSources',params:request},{signal:abort.signal})
        check();abort.signal.throwIfAborted()
        if(!isIntegrationReply(reply)||reply.requestId!==request.requestId||reply.operationId!==null)throw new Error('TASK_CAPABILITY_SCOPE_RECORD_INVALID_REPLY')
        if(reply.status!=='completed'||reply.error!==null)throw new Error('TASK_CAPABILITY_SCOPE_RECORD_CURRENT_UNAVAILABLE')
        const value=reply.result
        if(!isIntegrationTaskCapabilityScopeSnapshot(value)||value.threadId!==selected.initialAttempt.threadId||!Number.isSafeInteger(value.revision)||value.revision<Math.max(1,minimumRevision))throw new Error('TASK_CAPABILITY_SCOPE_RECORD_INVALID_REPLY')
        return structuredClone(value)
      }finally{pending.delete(abort);signal?.removeEventListener('abort',cancel)}
    },
    dispose(){active=false;for(const abort of pending)abort.abort();pending.clear()},
  }
}
