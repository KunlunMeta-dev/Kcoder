import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import { record, text, type PendingGatewayQuestion } from './contracts'
import {
  isInteractionStatusReadParamsV1,
  isInteractionStatusReadResultV1,
  isTaskInteractionReferenceV1,
  isTaskInteractionRespondParamsV1,
  isTaskInteractionPresentationV1,
} from '../../../../../shared/generated/contractGuards.mjs'
import type {
  TaskInteractionReferenceV1,
  TaskInteractionPresentationV1,
  TaskInteractionItemV1,
  TaskInteractionSnapshotV1,
  TaskInteractionStateV1,
  TaskInteractionRespondResultV1,
} from '../../../../../shared/generated/contracts'

interface CapturedInteraction {
  reference: TaskInteractionReferenceV1
  targetId: string
  taskId: string
  workspacePath: string
  targetScope: string
  client: GatewayClient
  connectionId: string | undefined
  pending: PendingGatewayQuestion
  presentation?: TaskInteractionPresentationV1
  account: (targetId: string) => boolean
  sending: boolean
  outcomeUnknown: boolean
}
// These are bounded client projections of original native receipts, never a task ledger.
const captured = new WeakMap<GatewayRuntimeCore, Map<string, CapturedInteraction>>()
function key(reference: TaskInteractionReferenceV1): string {
  const s=reference.selector
  return JSON.stringify([reference.attemptId,s.serverId,s.threadId,s.turnId,s.requestId,s.appServerEpoch,s.kind,s.approvalId??null,s.questionId??null])
}
function unavailable(): Error { return new Error('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE') }
function originalAttempt(runtime: GatewayRuntimeCore, taskId: string, reference: TaskInteractionReferenceV1): boolean {
  const s=reference.selector, task=runtime.tasks.get(taskId), turn=task?.runtimeHandle.memoryTaskSnapshot
  return !!turn && turn.threadId===s.threadId && turn.turnId===s.turnId && turn.attemptId===reference.attemptId &&
    turn.serverInstanceId===s.serverId && !turn.retiredServerInstances?.includes(s.serverId) &&
    runtime.turnAttemptIds.get(`${taskId}:${s.turnId}`)===reference.attemptId &&
    runtime.activeTurnByTask.get(taskId)?.turnId===s.turnId
}
function validReference(value: unknown): value is TaskInteractionReferenceV1 {
  if(!isTaskInteractionReferenceV1(value)||!isInteractionStatusReadParamsV1(value.selector))return false
  const s=value.selector
  return value.attemptId.length>0&&value.attemptId.length<=256&&Number.isSafeInteger(s.requestId)&&s.requestId>0&&
    [s.serverId,s.threadId,s.turnId,s.appServerEpoch].every(value=>value.length>0&&value.length<=1024)&&
    (s.kind==='approval' ? typeof s.approvalId==='string'&&s.approvalId.length>0&&!s.questionId : typeof s.questionId==='string'&&s.questionId.length>0&&!s.approvalId)
}
function presentation(pending: PendingGatewayQuestion): TaskInteractionPresentationV1 | undefined {
  const payload=pending.renderPayload
  if(payload.sourceAgent!==undefined||!Array.isArray(payload.questions)||payload.questions.length<1||payload.questions.length>8)return
  const questions=[]
  for(const raw of payload.questions){
    const q=record(raw)
    // Secret requests keep the original conversation's presentation and owner.
    if(q.isSecret===true||typeof q.id!=='string'||typeof q.header!=='string'||typeof q.question!=='string'||!Array.isArray(q.options))return
    const options=[]
    for(const option of q.options){const value=record(option);if(typeof value.label!=='string'||typeof value.description!=='string')return;options.push({label:value.label,description:value.description})}
    questions.push({id:q.id,header:q.header,question:q.question,isOther:q.isOther===true||q.is_other===true,options,
      ...(q.multiSelect===true||q.multi_select===true?{multiSelect:true}:{})})
  }
  const approval=payload.approvalPresentation===undefined?null:structuredClone(payload.approvalPresentation)
  const value={questions,approval}
  if(!isTaskInteractionPresentationV1(value))return
  if(value.approval&&value.questions.some(question=>question.multiSelect===true))return
  if(new Set(value.questions.map(question=>question.id)).size!==value.questions.length)return
  if(value.questions.some(q=>!q.id||q.id.length>256||q.header.length>4096||q.question.length>65536||q.options.length>16||q.options.some(o=>o.label.length>4096||o.description.length>16384)))return
  if(value.approval&&[value.approval.subject,value.approval.input,value.approval.reason].some(value=>value!=null&&value.length>65536))return
  return value
}

/** Called only by the native server-request forwarder after it stores the actual pending object. */
export async function captureTaskInteraction(
  runtime: GatewayRuntimeCore, client: GatewayClient, taskId: string, raw: Record<string,unknown>, requestId: number
): Promise<void> {
  const pending=runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`), task=runtime.tasks.get(taskId)
  const witness=task?.runtimeHandle.memoryTaskSnapshot
  if(runtime.disposed||runtime.appServerDisconnectedClients.has(client)||!pending||pending.client!==client||!task||runtime.clientByTask.get(taskId)!==client||!witness)return
  const reference={attemptId:witness.attemptId,selector:{serverId:raw.serverId,threadId:raw.threadId,turnId:raw.turnId,requestId,appServerEpoch:raw.appServerEpoch,
    ...(pending.approvalId?{kind:'approval',approvalId:pending.approvalId}:{kind:'question',questionId:pending.questionId})}}
  const view=raw.sourceAgent===undefined?presentation(pending):undefined
  if(!validReference(reference)||!originalAttempt(runtime,taskId,reference)||
    (view&&(reference.selector.kind==='approval')!==!!view.approval)||client.supportsExperimental?.('interactionStatusReadV1')!==true||
    client.supportsExperimental?.('interactionBindingV1')!==true)return
  const account=captureAccountContextRevision()
  // The map entry can be mutated or replaced while target resolution waits.
  // Capture the original binding, then check the current entry before storing it.
  const targetId=task.serverId, workspacePath=task.workspacePath
  const connectionId=client.diagnosticConnection?.connectionId
  const server=await runtime.serverForParams({deviceId:targetId})
  const currentTask=runtime.tasks.get(taskId)
  if(runtime.disposed||!account(targetId)||runtime.appServerDisconnectedClients.has(client)||
    client.diagnosticConnection?.connectionId!==connectionId||
    currentTask?.serverId!==targetId||!sameWorkspacePath(currentTask.workspacePath,workspacePath)||
    runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!==pending||runtime.clientByTask.get(taskId)!==client||!originalAttempt(runtime,taskId,reference))return
  let values=captured.get(runtime);if(!values){values=new Map();captured.set(runtime,values)}
  const id=key(reference)
  const previous=values.get(id)
  if(previous?.pending===pending&&previous.client===client&&previous.connectionId===connectionId)return
  if(!previous&&values.size>=256){const oldest=values.keys().next().value;if(oldest!==undefined)values.delete(oldest)}
  // Only a newly captured native request can renew the binding. A lost send
  // remains unknown even when that request is replayed on a new connection.
  values.set(id,{reference:structuredClone(reference),targetId,taskId,workspacePath,targetScope:hookTargetScope(server),client,connectionId,pending,presentation:view,account,sending:false,
    outcomeUnknown:previous?.outcomeUnknown===true||previous?.sending===true||previous?.pending.responsePending===true})
}

function assertCurrentOwner(runtime: GatewayRuntimeCore, owned: CapturedInteraction): void {
  const task = runtime.tasks.get(owned.taskId)
  if (runtime.disposed || !owned.account(owned.targetId) ||
      runtime.clientByTask.get(owned.taskId) !== owned.client ||
      runtime.appServerDisconnectedClients.has(owned.client) ||
      owned.client.diagnosticConnection?.connectionId !== owned.connectionId ||
      task?.threadId !== owned.reference.selector.threadId || task.serverId !== owned.targetId ||
      !sameWorkspacePath(task.workspacePath, owned.workspacePath)) throw unavailable()
}

class NativeStatusReadError extends Error {}

async function current(runtime:GatewayRuntimeCore, owned:CapturedInteraction, signal?:AbortSignal):Promise<()=>void>{
  const directory = runtime.commandDirectoryRefresh?.get(undefined)
  const target = runtime.commandDirectoryRefresh?.get(owned.targetId)
  const assertCurrent = () => {
    signal?.throwIfAborted()
    assertCurrentOwner(runtime, owned)
    // A refresh suspends dispatch before it knows whether this target changed.
    // Keep checking in callers after this helper's completion microtask too.
    if (runtime.commandDirectoryRefresh?.get(undefined) !== directory ||
        runtime.commandDirectoryRefresh?.get(owned.targetId) !== target)
      throw new NativeStatusReadError('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  }
  signal?.throwIfAborted()
  assertCurrentOwner(runtime, owned)
  // Current-owner authority failures must reject the read, preserving the draft.
  let server: Awaited<ReturnType<GatewayRuntimeCore['serverForParams']>>
  try { server = await runtime.serverForParams({deviceId:owned.targetId}) }
  catch { assertCurrent(); throw new NativeStatusReadError() }
  // Target lookup can yield to disposal, disconnect or a task rebind. Re-read
  // every owner field before exposing a receipt or dispatching the old answer.
  assertCurrent()
  if(hookTargetScope(server)!==owned.targetScope)throw unavailable()
  try { await runtime.assertCommandTarget(server) }
  catch { assertCurrent(); throw new NativeStatusReadError() }
  assertCurrent()
  return assertCurrent
}
interface NativeObservation {
  state: TaskInteractionStateV1
  assertCurrent: () => void
}
async function nativeState(runtime:GatewayRuntimeCore, owned:CapturedInteraction, signal?:AbortSignal):Promise<NativeObservation>{
  const before = await current(runtime,owned,signal)
  before()
  let value: unknown
  try {
    value=await (owned.connectionId&&owned.client.requestOnConnection
      ? owned.client.requestOnConnection<unknown>(owned.connectionId,'interaction/status/read',owned.reference.selector,signal?{signal}:undefined)
      : owned.client.request<unknown>('interaction/status/read',owned.reference.selector,signal?{signal}:undefined))
  } catch {
    // Stale owners still hide their cards. A failed read on the current owner
    // must reach the UI's disabled-draft recovery path, not erase its snapshot.
    before()
    throw new NativeStatusReadError()
  }
  const after = await current(runtime,owned,signal)
  const assertCurrent = () => { before(); after() }
  assertCurrent()
  // An invalid current-owner receipt is a failed read, not an absent card.
  // Preserve the complete draft snapshot through the same recovery path as RPC failure.
  if(!isInteractionStatusReadResultV1(value)||key({attemptId:owned.reference.attemptId,selector:value})!==key(owned.reference))throw new NativeStatusReadError()
  return { state: projectState(runtime, owned, value.status === 'resolved' ? 'resolved' : value.status === 'pending' ? 'pending' : 'unknown'), assertCurrent }
}

function projectState(runtime: GatewayRuntimeCore, owned: CapturedInteraction, state: TaskInteractionStateV1): TaskInteractionStateV1 {
  if (state === 'resolved' || state === 'unknown') return state
  if (owned.outcomeUnknown ||
      runtime.pendingQuestionByKey.get(`${owned.taskId}\0${owned.reference.selector.requestId}`) !== owned.pending ||
      !originalAttempt(runtime, owned.taskId, owned.reference)) return 'unknown'
  return owned.sending || owned.pending.responsePending ? 'response_pending' : 'pending'
}
async function originalAddress(runtime:GatewayRuntimeCore,params:Record<string,unknown>,signal?:AbortSignal){
  signal?.throwIfAborted()
  // Keep the requested binding fixed while task lookup yields to caller edits.
  const account=captureAccountContextRevision(), address={...record(params.address)}
  if(typeof address.deviceId!=='string'||typeof address.threadId!=='string'||typeof address.taskId!=='string')throw unavailable()
  const resolved=await runtime.taskDescriptor({address:{...address}})
  signal?.throwIfAborted()
  if(runtime.disposed||!account(address.deviceId)||resolved.server.id!==address.deviceId||resolved.task.threadId!==address.threadId||
    (text(address.workspacePath)&&!sameWorkspacePath(String(address.workspacePath),resolved.task.workspacePath)))throw unavailable()
  return {resolved,account}
}
export async function readTaskInteractions(runtime:GatewayRuntimeCore,params:Record<string,unknown>,options?:{signal?:AbortSignal}):Promise<TaskInteractionSnapshotV1>{
  const {resolved,account}=await originalAddress(runtime,params,options?.signal)
  const threadId = resolved.task.threadId
  const values=[...(captured.get(runtime)?.values()??[])].filter(value=>value.taskId===resolved.taskId&&value.targetId===resolved.server.id&&value.reference.selector.threadId===threadId)
  const observations: (NativeObservation & { owned: CapturedInteraction })[] = []
  for(const value of values){
    try{observations.push({owned:value,...await nativeState(runtime,value,options?.signal)})}
    catch(error){options?.signal?.throwIfAborted();if(!account(resolved.server.id)||error instanceof NativeStatusReadError)throw unavailable()}
  }
  if(!account(resolved.server.id))throw unavailable()
  const items:TaskInteractionItemV1[]=[]
  let checked=0,originalViewRequired=false
  // A later card read can yield to disconnect, turn completion or another reply.
  // Publish the batch only after synchronously rechecking every captured owner.
  for (const { owned, state: observedState, assertCurrent } of observations) {
    try { assertCurrent() } catch (error) {
      options?.signal?.throwIfAborted()
      // A refresh invalidates the observation, not the original card. Reject
      // the whole read so the UI retains its disabled draft until fresh readback.
      if (error instanceof NativeStatusReadError) throw unavailable()
      continue
    }
    const state = projectState(runtime, owned, observedState)
    checked++
    if (owned.presentation) items.push({reference:structuredClone(owned.reference),state,presentation:structuredClone(owned.presentation)})
    else if (state !== 'resolved') originalViewRequired = true
  }
  if([...runtime.pendingQuestionByKey.values()].some(pending=>pending.taskId===resolved.taskId&&pending.client===runtime.clientByTask.get(resolved.taskId)&&!values.some(value=>value.pending===pending)))originalViewRequired=true
  // The display bound applies after authoritative reads. Old resolved receipts
  // must not permanently prevent a long-lived task's current cards from loading.
  // Keep every unresolved/unknown card and only omit the oldest resolved rows.
  let excess = items.length - 32
  const visibleItems = items.filter(item => {
    if (excess > 0 && item.state === 'resolved') { excess--; return false }
    return true
  })
  if (excess > 0) throw new Error('TASK_INTERACTION_OBSERVATION_LIMIT')
  const result:TaskInteractionSnapshotV1={schemaVersion:1,threadId,observationState:checked>0&&checked===values.length&&!originalViewRequired?'observed':'unknown',items:visibleItems,...(originalViewRequired?{originalViewRequired:true}:{})}
  if(new TextEncoder().encode(JSON.stringify(result)).length>512*1024)throw new Error('TASK_INTERACTION_OBSERVATION_LIMIT')
  return result
}
export async function respondTaskInteraction(runtime:GatewayRuntimeCore,params:Record<string,unknown>,options?:{signal?:AbortSignal}):Promise<TaskInteractionRespondResultV1>{
  if(!isTaskInteractionRespondParamsV1(params.response)||!validReference(params.response.reference))throw unavailable()
  // Keep the validated reference and nested answers fixed across owner/status
  // waits. Later caller draft edits belong to a separate submission.
  const response = structuredClone(params.response)
  const {resolved,account}=await originalAddress(runtime,params,options?.signal)
  const owned=captured.get(runtime)?.get(key(response.reference))
  if(!owned||!owned.presentation||owned.taskId!==resolved.taskId||owned.targetId!==resolved.server.id)throw unavailable()
  const observation=await nativeState(runtime,owned,options?.signal)
  observation.assertCurrent()
  const { state }=observation
  if(state!=='pending')return {reference:structuredClone(owned.reference),state}
  const answers=response.answers,questions=owned.presentation.questions
  if(Object.keys(answers).length!==questions.length||questions.some(q=>{
    if(!Object.hasOwn(answers,q.id))return true
    const selected=answers[q.id].answers
    if((q.multiSelect===true?(selected.length<1||selected.length>q.options.length+(q.isOther?1:0)):selected.length!==1)||new Set(selected).size!==selected.length||selected.some(value=>typeof value!=='string'||value.length>65536))return true
    const custom=selected.filter(value=>!q.options.some(option=>option.label===value))
    return q.isOther?custom.length>1:custom.length>0
  }))throw new Error('TASK_INTERACTION_INVALID_ANSWER')
  const assertDispatch=await current(runtime,owned,options?.signal)
  observation.assertCurrent()
  assertDispatch()
  if(!account(resolved.server.id)||!originalAttempt(runtime,owned.taskId,owned.reference)||owned.pending.responsePending||owned.sending)return {reference:structuredClone(owned.reference),state:'unknown'}
  owned.sending=true
  try{
    const result=await runtime.respondToTaskQuestion(owned.taskId,{requestId:owned.reference.selector.requestId,answers},owned.pending)
    assertDispatch()
    if(record(result).accepted!==true){owned.outcomeUnknown=true;return {reference:structuredClone(owned.reference),state:'unknown'}}
    return {reference:structuredClone(owned.reference),state:'response_pending'}
  }catch{owned.outcomeUnknown=true;return {reference:structuredClone(owned.reference),state:'unknown'}}
  finally{owned.sending=false}
}
