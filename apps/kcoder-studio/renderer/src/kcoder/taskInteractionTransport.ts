import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from './accountContextEvents'
import type { RuntimeTaskAddress, RequestUserInputResponse } from '@/types/api'
import type { TaskInteractionSnapshotV1, TaskInteractionReferenceV1, TaskInteractionRespondResultV1 } from '../../../shared/generated/contracts'
import { isTaskInteractionSnapshotV1, isTaskInteractionRespondResultV1 } from '../../../shared/generated/contractGuards.mjs'

export class TaskInteractionClientError extends Error {
  readonly code: 'scope_changed' | 'cancelled' | 'unavailable' | 'invalid_reply' | 'outcome_unknown'
  constructor(code:TaskInteractionClientError['code']){super(code);this.code=code}
}
export function taskInteractionKey(reference:TaskInteractionReferenceV1):string{
  const s=reference.selector
  return JSON.stringify([reference.attemptId,s.serverId,s.threadId,s.turnId,s.requestId,s.appServerEpoch,s.kind,s.approvalId??null,s.questionId??null])
}
/** The native status and original connection decide actionability; this is a UI lifetime only. */
export function createTaskInteractionTransport(address:RuntimeTaskAddress,isCurrent:()=>boolean){
  const owner=structuredClone(address), account=captureAccountContextRevision(), pending=new Set<AbortController>()
  let active=true
  const check = (mutation = false, signal?: AbortSignal) => {
    const code = !active || !isCurrent() || !account(owner.deviceId)
      ? 'scope_changed' : signal?.aborted ? 'cancelled' : undefined
    if (code) throw new TaskInteractionClientError(mutation ? 'outcome_unknown' : code)
  }
  const call=async(method:string,params:Record<string,unknown>,mutation:boolean,signal?:AbortSignal):Promise<unknown>=>{
    check();const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();pending.add(abort)
    let sent=false
    try{abort.signal.throwIfAborted();check();sent=true;const value=await requestLocalExecutor<unknown>(method,{address:owner,...params},{signal:abort.signal});abort.signal.throwIfAborted();check();return value}
    catch(error){if(mutation&&sent)throw new TaskInteractionClientError('outcome_unknown');if(abort.signal.aborted)throw new TaskInteractionClientError('cancelled');if(error instanceof TaskInteractionClientError)throw error;check();throw new TaskInteractionClientError('unavailable')}
    finally{pending.delete(abort);signal?.removeEventListener('abort',cancel)}
  }
  return {
    async read(signal?:AbortSignal):Promise<TaskInteractionSnapshotV1>{
      const value=await call('runtime.tasks.interactions.read',{},false,signal)
      // The helper's final check precedes this continuation's microtask. A
      // queued lifecycle event must fence publication here as well.
      check(false, signal)
      if(!isTaskInteractionSnapshotV1(value)||value.schemaVersion!==1||value.threadId!==owner.threadId||value.items.length>32)
        throw new TaskInteractionClientError('invalid_reply')
      const seen=new Set<string>()
      for(const item of value.items){const k=taskInteractionKey(item.reference);if(item.reference.selector.threadId!==owner.threadId||seen.has(k)||item.presentation.questions.length<1||item.presentation.questions.length>8)throw new TaskInteractionClientError('invalid_reply');seen.add(k)}
      return structuredClone(value)
    },
    async respond(reference:TaskInteractionReferenceV1,response:RequestUserInputResponse,signal?:AbortSignal):Promise<TaskInteractionRespondResultV1>{
      // Bind dispatch and receipt checks to the same original interaction.
      // Caller-owned projections can change while the executor reply is pending.
      const originalReference = structuredClone(reference)
      const referenceKey = taskInteractionKey(originalReference)
      const itemId = originalReference.selector.kind === 'approval'
        ? originalReference.selector.approvalId : originalReference.selector.questionId
      const requestIds = [response.requestId, response.request_id].filter(value => value !== undefined)
      // Request IDs may be reused by other interactions or subagents. Do not
      // discard a conflicting card, task, turn or lifetime identity when projecting answers.
      if (originalReference.selector.threadId !== owner.threadId ||
          requestIds.length === 0 ||
          requestIds.some(value => String(value) !== String(originalReference.selector.requestId)) ||
          [response.itemId, response.item_id].some(value => value !== undefined && value !== itemId) ||
          (['threadId', 'turnId', 'appServerEpoch'] as const).some(field =>
            response[field] !== undefined && response[field] !== originalReference.selector[field]) ||
          response.sourceAgent !== undefined) {
        throw new TaskInteractionClientError('invalid_reply')
      }
      const value = await call('runtime.tasks.interactions.respond', {
        response: { reference: originalReference, answers: structuredClone(response.answers) },
      }, true, signal)
      // Dispatch already happened; a stale confirmation is an unknown outcome.
      check(true, signal)
      if (!isTaskInteractionRespondResultV1(value) || taskInteractionKey(value.reference) !== referenceKey) {
        throw new TaskInteractionClientError('outcome_unknown')
      }
      return value
    },
    dispose(){active=false;for(const abort of pending)abort.abort();pending.clear()},
  }
}
