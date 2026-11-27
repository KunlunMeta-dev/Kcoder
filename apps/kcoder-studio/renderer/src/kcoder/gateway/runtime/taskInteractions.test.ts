import { expect, test, vi } from 'vitest'
import { captureTaskInteraction, readTaskInteractions, respondTaskInteraction } from './taskInteractions'
import { respondToTaskQuestion } from './interactions'
import { notifyAccountContextChange } from '../../accountContextEvents'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { PendingGatewayQuestion } from './contracts'
vi.mock('../../gatewayServiceBridge',()=>({emitRuntimeEvent:vi.fn(async()=>{})}))

function fixture(kind:'approval'|'question'='question'){
  const targetId=`task-interaction-${Math.random()}`,taskId='actual-original-task',requestId=2000001
  const frame={serverId:'actual-native-server',threadId:'original-thread',turnId:'original-turn',appServerEpoch:'original-epoch'}
  let nativeStatus='pending',replies=0
  const client={supportsExperimental:()=>true,request:vi.fn(async(_method,selector)=>({...selector,status:nativeStatus})),respond:vi.fn(()=>{replies++})} as unknown as GatewayClient
  const questionId='question-2000001',approvalId='approval-2000001'
  const pending:PendingGatewayQuestion={client,taskId,requestId,turnId:frame.turnId,block:{id:'original-block'},
    renderPayload:{kind:'request_user_input',requestId,itemId:kind==='approval'?approvalId:questionId,questions:[{id:'choice',header:'Original request',question:'Choose for the original task',isOther:false,options:[{label:'Continue',description:'Original operation only'},{label:'Decline',description:'Do not continue'}]}],
      ...(kind==='approval'?{approvalPresentation:{kind:'tool',subject:'FileWrite',input:'{}',reason:'Original controlled file'}}:{})},
    ...(kind==='approval'?{approvalId,approvalDecisions:{Continue:'accept',Decline:'decline'}}:{questionId})}
  const task={taskId,serverId:targetId,threadId:frame.threadId,workspacePath:'/owned',runtimeHandle:{memoryTaskSnapshot:{snapshotId:null,threadId:frame.threadId,turnId:frame.turnId,attemptId:'accepted-attempt',serverInstanceId:frame.serverId,sequence:12}}}
  const server={id:targetId,transport:'local',command:'/owned/kcoder',workspacePath:'/owned'}
  const core={disposed:false,appServerDisconnectedClients:new WeakSet(),tasks:new Map([[taskId,task]]),clientByTask:new Map([[taskId,client]]),threadByTask:new Map([[taskId,frame.threadId]]),turnAttemptIds:new Map([[`${taskId}:${frame.turnId}`,'accepted-attempt']]),activeTurnByTask:new Map([[taskId,{turnId:frame.turnId}]]),pendingQuestionByKey:new Map([[`${taskId}\0${requestId}`,pending]]),
    resolveTaskId: (id: string | null) => id,
    taskDescriptor:vi.fn(async()=>({taskId,task,server})),serverForParams:vi.fn(async()=>server),assertCommandTarget:vi.fn(async()=>{}),respondToTaskQuestion:(id:string,response:Record<string,unknown>,expected?:PendingGatewayQuestion)=>respondToTaskQuestion.call(core,id,response,expected),
  } as unknown as GatewayRuntimeCore
  const address={deviceId:targetId,taskId,threadId:frame.threadId,workspacePath:'/owned'}
  return {core,client,pending,task,server,address,frame,taskId,requestId,replyCount:()=>replies,setStatus:(value:string)=>{nativeStatus=value},capture:()=>captureTaskInteraction(core,client,taskId,frame,requestId)}
}
test('actual original client request captures its accepted attempt and checks the native epoch receipt',async()=>{
  const f=fixture();await f.capture()
  const result=await readTaskInteractions(f.core,{address:f.address})
  expect(result.observationState).toBe('observed');expect(result.items[0].state).toBe('pending')
  expect(result.items[0].reference).toMatchObject({attemptId:'accepted-attempt',selector:{...f.frame,requestId:f.requestId,kind:'question',questionId:'question-2000001'}})
  expect(f.client.request).toHaveBeenCalledWith('interaction/status/read',result.items[0].reference.selector,undefined)
  expect(f.replyCount()).toBe(0)
})
test.each(['approval','question'] as const)('%s sends only the exact original response once and waits for native confirmation',async kind=>{
  const f=fixture(kind);await f.capture();const read=await readTaskInteractions(f.core,{address:f.address});const reference=read.items[0].reference
  const response={reference,answers:{choice:{answers:['Continue']}}}
  const first=await respondTaskInteraction(f.core,{address:f.address,response})
  expect(first.state).toBe('response_pending');expect(f.replyCount()).toBe(1)
  const duplicate=await respondTaskInteraction(f.core,{address:f.address,response})
  expect(duplicate.state).toBe('response_pending');expect(f.replyCount()).toBe(1)
  expect(await readTaskInteractions(f.core,{address:f.address})).toMatchObject({items:[{state:'response_pending'}]})
  f.setStatus('resolved')
  expect(await readTaskInteractions(f.core,{address:f.address})).toMatchObject({items:[{state:'resolved'}]})
  expect(f.replyCount()).toBe(1)
  expect(f.client.respond).toHaveBeenCalledWith(f.requestId,expect.objectContaining({threadId:f.frame.threadId,turnId:f.frame.turnId,...(kind==='approval'?{approvalId:'approval-2000001',decision:'accept'}:{questionId:'question-2000001',answers:response.answers})}))
})
test('lost send outcome remains unknown and never automatically repeats the original response',async()=>{
  const f=fixture('approval');await f.capture();const ref=(await readTaskInteractions(f.core,{address:f.address})).items[0].reference
  vi.mocked(f.client.respond!).mockImplementation(()=>{throw new Error('Bounded transport failure')})
  const response={reference:ref,answers:{choice:{answers:['Continue']}}}
  expect((await respondTaskInteraction(f.core,{address:f.address,response})).state).toBe('unknown')
  expect((await respondTaskInteraction(f.core,{address:f.address,response})).state).toBe('unknown')
  expect(f.client.respond).toHaveBeenCalledTimes(1)
})
test('forged turn, attempt, native epoch, request or task target never gains response authority',async()=>{
  const f=fixture();await f.capture();const ref=(await readTaskInteractions(f.core,{address:f.address})).items[0].reference
  for(const mutate of [
    (value:typeof ref)=>{value.attemptId='other-attempt'},(value:typeof ref)=>{value.selector.turnId='other-turn'},
    (value:typeof ref)=>{value.selector.appServerEpoch='other-epoch'},(value:typeof ref)=>{value.selector.requestId++},
  ]){const reference=structuredClone(ref);mutate(reference);await expect(respondTaskInteraction(f.core,{address:f.address,response:{reference,answers:{choice:{answers:['Continue']}}}})).rejects.toThrow()}
  await expect(readTaskInteractions(f.core,{address:{...f.address,deviceId:'other-target'}})).rejects.toThrow()
  expect(f.replyCount()).toBe(0)
})
test('old client, source mismatch, missing accepted witness or missing epoch remain unknown, never empty-success',async()=>{
  for(const variant of ['no-witness','no-epoch','other-attempt','source-agent','old-client']){
    const f=fixture()
    if(variant==='no-witness')f.task.runtimeHandle.memoryTaskSnapshot=undefined as never
    if(variant==='other-attempt')f.core.turnAttemptIds.set(`${f.taskId}:${f.frame.turnId}`,'other-attempt')
    if(variant==='old-client')f.core.clientByTask.set(f.taskId,{} as GatewayClient)
    await captureTaskInteraction(f.core,f.client,f.taskId,{...f.frame,...(variant==='no-epoch'?{appServerEpoch:undefined}:{}),...(variant==='source-agent'?{sourceAgent:{agentId:'child'}}:{})},f.requestId)
    expect(await readTaskInteractions(f.core,{address:f.address})).toMatchObject({observationState:'unknown',items:[]})
    if(variant==='source-agent')expect(f.client.request).toHaveBeenCalledOnce();else expect(f.client.request).not.toHaveBeenCalled();expect(f.replyCount()).toBe(0)
  }
})
test('native echo mismatch fails reads while account or client replacement hides old presentation without sending',async()=>{
  for(const variant of ['echo','account','client']){
    const f=fixture();await f.capture()
    if(variant==='echo')vi.mocked(f.client.request).mockImplementation(async(_method,selector)=>({...selector,appServerEpoch:'foreign',status:'pending'}) as never)
    if(variant==='account')notifyAccountContextChange(f.address.deviceId)
    if(variant==='client')f.core.clientByTask.set(f.taskId,{} as GatewayClient)
    if(variant==='echo')await expect(readTaskInteractions(f.core,{address:f.address})).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    else expect(await readTaskInteractions(f.core,{address:f.address})).toMatchObject({observationState:'unknown',items:[]})
    expect(f.replyCount()).toBe(0)
  }
})

test('native multiSelect presentation preserves several original answers and cannot approve twice',async()=>{
  const f=fixture();(f.pending.renderPayload.questions as Record<string,unknown>[])[0].multiSelect=true
  await f.capture();const view=await readTaskInteractions(f.core,{address:f.address})
  expect(view.items[0].presentation.questions[0].multiSelect).toBe(true)
  const response={reference:view.items[0].reference,answers:{choice:{answers:['Continue','Decline']}}}
  expect((await respondTaskInteraction(f.core,{address:f.address,response})).state).toBe('response_pending')
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId,expect.objectContaining({answers:response.answers}))
  await respondTaskInteraction(f.core,{address:f.address,response});expect(f.client.respond).toHaveBeenCalledOnce()
})
test('multiSelect rejects duplicated, unknown or empty selections without effects',async()=>{
  const f=fixture();(f.pending.renderPayload.questions as Record<string,unknown>[])[0].multiSelect=true
  await f.capture();const view=await readTaskInteractions(f.core,{address:f.address})
  for(const answers of [[],['Continue','Continue'],['invented']])
    await expect(respondTaskInteraction(f.core,{address:f.address,response:{reference:view.items[0].reference,answers:{choice:{answers}}}})).rejects.toThrow('TASK_INTERACTION_INVALID_ANSWER')
  expect(f.replyCount()).toBe(0)
})
test('a secret or source-agent request has an explicit original-view notice and cannot acquire a parent reply path',async()=>{
  for(const variant of ['secret','source-agent']){
    const f=fixture()
    if(variant==='secret')(f.pending.renderPayload.questions as Record<string,unknown>[])[0].isSecret=true
    await captureTaskInteraction(f.core,f.client,f.taskId,{...f.frame,...(variant==='source-agent'?{sourceAgent:{agentId:'original-child'}}:{})},f.requestId)
    const view=await readTaskInteractions(f.core,{address:f.address})
    expect(view).toMatchObject({observationState:'unknown',originalViewRequired:true,items:[]})
    expect(JSON.stringify(view)).not.toContain('Choose for the original task')
    expect(f.replyCount()).toBe(0)
  }
})


const ownerChanges = ['disposed', 'disconnected', 'thread', 'target', 'workspace', 'removed'] as const
function changeOwner(f: ReturnType<typeof fixture>, change: typeof ownerChanges[number]) {
  if (change === 'disposed') f.core.disposed = true
  if (change === 'disconnected') f.core.appServerDisconnectedClients.add(f.client)
  if (change === 'thread') f.task.threadId = 'replacement-thread'
  if (change === 'target') f.task.serverId = 'replacement-target'
  if (change === 'workspace') f.task.workspacePath = '/replacement-workspace'
  if (change === 'removed') f.core.tasks.delete(f.taskId)
}

async function expectStatusReadAfterOwnerChange(
  reading: ReturnType<typeof readTaskInteractions>,
  change: typeof ownerChanges[number] | 'client',
) {
  if (change === 'disconnected' || change === 'client') {
    expect(await reading).toMatchObject({ observationState: 'unknown', items: [] })
  } else {
    await expect(reading).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  }
}

// Pause the actual target resolver; ownership changes while its promise waits.
function pauseTargetLookup(f: ReturnType<typeof fixture>, at: number) {
  let calls = 0
  let resume!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  vi.mocked(f.core.serverForParams).mockImplementation(async () => {
    if (++calls === at) {
      started()
      await new Promise<void>(resolve => { resume = resolve })
    }
    return f.server
  })
  return { waiting, resume: () => resume() }
}

test.each(ownerChanges)('status read refuses a %s owner changed during target lookup', async change => {
  const f = fixture()
  await f.capture()
  const paused = pauseTargetLookup(f, 1)
  const reading = readTaskInteractions(f.core, { address: f.address })
  await paused.waiting
  changeOwner(f, change)
  paused.resume()
  await expectStatusReadAfterOwnerChange(reading, change)
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.replyCount()).toBe(0)
})

test.each(ownerChanges)('a resolved receipt stays hidden if its %s owner changes during post-read lookup', async change => {
  const f = fixture()
  await f.capture()
  f.setStatus('resolved')
  const paused = pauseTargetLookup(f, 2)
  const reading = readTaskInteractions(f.core, { address: f.address })
  await paused.waiting
  changeOwner(f, change)
  paused.resume()
  await expectStatusReadAfterOwnerChange(reading, change)
  expect(f.client.request).toHaveBeenCalledOnce()
  expect(f.replyCount()).toBe(0)
})

test.each(ownerChanges)('answer refuses a %s owner changed during final target lookup without consuming the question', async change => {
  const f = fixture()
  await f.capture()
  const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
  const paused = pauseTargetLookup(f, 3)
  const answering = respondTaskInteraction(f.core, {
    address: f.address, response: { reference, answers: { choice: { answers: ['Continue'] } } },
  })
  const rejected = expect(answering).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  await paused.waiting
  changeOwner(f, change)
  paused.resume()
  await rejected
  expect(f.replyCount()).toBe(0)
  expect(f.pending.responsePending).toBeUndefined()
  expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
})


async function twoQuestionRead() {
  const f = fixture()
  await f.capture()
  const requestId = f.requestId + 1
  const questionId = 'question-second'
  const second = {
    ...f.pending, requestId, questionId,
    renderPayload: { ...f.pending.renderPayload, requestId, itemId: questionId },
  }
  f.core.pendingQuestionByKey.set(`${f.taskId}\0${requestId}`, second)
  await captureTaskInteraction(f.core, f.client, f.taskId, f.frame, requestId)
  let finish!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  vi.mocked(f.client.request).mockImplementation(async (_method, selector) => {
    if (selector?.requestId === requestId) {
      started()
      await new Promise<void>(resolve => { finish = resolve })
    }
    return { ...selector, status: 'pending' } as never
  })
  const reading = readTaskInteractions(f.core, { address: f.address })
  await waiting
  return { f, second, reading, finish: () => finish() }
}

const captureBindingChanges = ['workspace-in-place', 'workspace-replacement', 'target-in-place'] as const
test.each((['approval', 'question'] as const).flatMap(kind =>
  (['before', 'during'] as const).map(boundary => [kind, boundary] as const)))(
  '%s capture refused %s lookup cannot become actionable after reconnect', async (kind, boundary) => {
    const f = fixture(kind)
    if (boundary === 'before') {
      f.core.appServerDisconnectedClients.add(f.client)
      await f.capture()
      expect(f.core.serverForParams).not.toHaveBeenCalled()
    } else {
      const paused = pauseTargetLookup(f, 1)
      const capturing = f.capture()
      await paused.waiting
      f.core.appServerDisconnectedClients.add(f.client)
      paused.resume()
      await capturing
    }
    f.core.appServerDisconnectedClients.delete(f.client)
    expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
      observationState: 'unknown', originalViewRequired: true, items: [],
    })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.replyCount()).toBe(0)
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
  }
)

test.each((['approval', 'question'] as const).flatMap(kind =>
  captureBindingChanges.map(change => [kind, change] as const)))(
  '%s capture cannot adopt a %s binding changed during target lookup', async (kind, change) => {
    const f = fixture(kind)
    const paused = pauseTargetLookup(f, 1)
    const capturing = f.capture()
    await paused.waiting
    if (change === 'workspace-in-place') f.task.workspacePath = '/replacement-workspace'
    if (change === 'workspace-replacement') {
      f.core.tasks.set(f.taskId, { ...f.task, workspacePath: '/replacement-workspace' } as never)
    }
    if (change === 'target-in-place') {
      f.task.serverId = 'replacement-target'
      f.server.id = 'replacement-target'
    }
    paused.resume()
    await capturing
    const task = f.core.tasks.get(f.taskId)!
    vi.mocked(f.core.taskDescriptor).mockResolvedValue({ taskId: f.taskId, task, server: f.server } as never)
    const address = { ...f.address, deviceId: task.serverId, workspacePath: task.workspacePath }
    expect(await readTaskInteractions(f.core, { address })).toMatchObject({
      observationState: 'unknown', originalViewRequired: true, items: [],
    })
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.replyCount()).toBe(0)
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
  }
)

test.each(['approval', 'question'] as const)(
  '%s capture permits a projection replacement with the original binding', async kind => {
    const f = fixture(kind)
    const paused = pauseTargetLookup(f, 1)
    const capturing = f.capture()
    await paused.waiting
    f.core.tasks.set(f.taskId, { ...f.task } as never)
    paused.resume()
    await capturing
    expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
      observationState: 'observed', items: [{ state: 'pending' }],
    })
    expect(f.replyCount()).toBe(0)
  }
)

test.each([...ownerChanges, 'client'] as const)(
  'a later card lookup cannot publish an earlier pending card after %s ownership changes', async change => {
    const { f, second, reading, finish } = await twoQuestionRead()
    if (change === 'client') f.core.clientByTask.set(f.taskId, {} as GatewayClient)
    else changeOwner(f, change)
    finish()
    await expectStatusReadAfterOwnerChange(reading, change)
    expect(f.replyCount()).toBe(0)
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${second.requestId}`)).toBe(second)
  }
)

test('a turn ending during another card lookup cannot publish an earlier actionable card', async () => {
  const { f, reading, finish } = await twoQuestionRead()
  f.core.activeTurnByTask.delete(f.taskId)
  finish()
  expect((await reading).items.map(item => item.state)).toEqual(['unknown', 'unknown'])
  expect(f.replyCount()).toBe(0)
})

test('an answer sent during another card lookup is response-pending in the published batch', async () => {
  const { f, reading, finish } = await twoQuestionRead()
  await f.core.respondToTaskQuestion(f.taskId, {
    requestId: f.requestId, answers: { choice: { answers: ['Continue'] } },
  }, f.pending)
  finish()
  expect((await reading).items.map(item => item.state)).toEqual(['response_pending', 'pending'])
  expect(f.replyCount()).toBe(1)
})


test('an unchanged batch retains both original pending cards with one status read each', async () => {
  const { f, reading, finish } = await twoQuestionRead()
  finish()
  const result = await reading
  expect(result).toMatchObject({ threadId: f.frame.threadId, observationState: 'observed' })
  expect(result.items.map(item => item.state)).toEqual(['pending', 'pending'])
  expect(f.client.request).toHaveBeenCalledTimes(2)
  expect(f.replyCount()).toBe(0)
})


test.each(['approval', 'question'] as const)(
  '%s keeps its original input snapshot across task lookup and caller response replacement', async kind => {
    const f = fixture(kind)
    await f.capture()
    const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    const originalReference = structuredClone(reference)
    const params = { address: f.address, response: { reference, answers: { choice: { answers: ['Continue'] } } } }
    let resume!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    vi.mocked(f.core.taskDescriptor).mockImplementationOnce(async () => {
      started()
      await new Promise<void>(resolve => { resume = resolve })
      return { taskId: f.taskId, task: f.task, server: f.server } as never
    })
    const answering = respondTaskInteraction(f.core, params)
    const outcome = answering.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await waiting
    params.response = { reference: { ...reference, attemptId: 'another-attempt' },
      answers: { choice: { answers: ['Decline'] } } }
    reference.selector.requestId++
    resume()
    const result = await outcome
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ reference: originalReference, state: 'response_pending' })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, expect.objectContaining(
      kind === 'approval' ? { decision: 'accept' } : { answers: { choice: { answers: ['Continue'] } } }
    ))
  }
)

test.each(['approval', 'question'] as const)(
  '%s sends the validated answer snapshot when the caller edits nested selections during final lookup', async kind => {
    const f = fixture(kind)
    await f.capture()
    const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    const answers = { choice: { answers: ['Continue'] } }
    const paused = pauseTargetLookup(f, 3)
    const answering = respondTaskInteraction(f.core, { address: f.address, response: { reference, answers } })
    await paused.waiting
    answers.choice.answers[0] = 'Decline'
    paused.resume()
    expect((await answering).state).toBe('response_pending')
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, expect.objectContaining(
      kind === 'approval' ? { decision: 'accept' } : { answers: { choice: { answers: ['Continue'] } } }
    ))
    expect(f.pending.submittedResponse).toMatchObject({ answers: { choice: { answers: ['Continue'] } } })
  }
)


async function captureQuestionHistory(
  f: ReturnType<typeof fixture>, states: ('pending' | 'resolved' | 'unknown' | 'response_pending')[]
) {
  f.core.pendingQuestionByKey.clear()
  vi.mocked(f.client.request).mockImplementation(async (_method, selector) => ({
    ...selector,
    status: states[selector.requestId - f.requestId] === 'resolved' ? 'resolved' : 'pending',
  }) as never)
  const requests: PendingGatewayQuestion[] = []
  for (const [index, state] of states.entries()) {
    const requestId = f.requestId + index
    const pending: PendingGatewayQuestion = {
      ...f.pending, requestId,
      block: { id: `history-block-${requestId}` },
      renderPayload: { ...structuredClone(f.pending.renderPayload), requestId },
      ...(f.pending.approvalId ? { approvalId: `approval-${requestId}` } : { questionId: `question-${requestId}` }),
      ...(state === 'response_pending' ? { responsePending: true } : {}),
    }
    const pendingKey = `${f.taskId}\0${requestId}`
    f.core.pendingQuestionByKey.set(pendingKey, pending)
    await captureTaskInteraction(f.core, f.client, f.taskId, f.frame, requestId)
    if (state === 'resolved' || state === 'unknown') f.core.pendingQuestionByKey.delete(pendingKey)
    requests.push(pending)
  }
  return requests
}

test.each(['approval', 'question'] as const)(
  '%s refresh survives more than 32 captured requests after native resolution', async kind => {
    const f = fixture(kind)
    await captureQuestionHistory(f, [...Array<'resolved'>(32).fill('resolved'), 'pending'])
    const result = await readTaskInteractions(f.core, { address: f.address })
    expect(result.observationState).toBe('observed')
    expect(result.items).toHaveLength(32)
    expect(result.items.filter(item => item.state === 'resolved')).toHaveLength(31)
    const active = result.items.find(item => item.state === 'pending')!
    expect(active.reference.selector.requestId).toBe(f.requestId + 32)
    expect(f.client.request).toHaveBeenCalledTimes(33)
    expect(f.replyCount()).toBe(0)
    expect((await respondTaskInteraction(f.core, { address: f.address, response: {
      reference: active.reference, answers: { choice: { answers: ['Continue'] } },
    } })).state).toBe('response_pending')
    expect(f.replyCount()).toBe(1)
    expect((await readTaskInteractions(f.core, { address: f.address })).items
      .find(item => item.reference.selector.requestId === f.requestId + 32)?.state).toBe('response_pending')
  }
)

test.each(['pending', 'response_pending', 'unknown'] as const)(
  'resolved history compaction preserves the oldest %s card', async state => {
    const f = fixture()
    await captureQuestionHistory(f, [state, ...Array<'resolved'>(33).fill('resolved')])
    const result = await readTaskInteractions(f.core, { address: f.address })
    expect(result.observationState).toBe('observed')
    expect(result.items).toHaveLength(32)
    expect(result.items[0]).toMatchObject({ state, reference: { selector: { requestId: f.requestId } } })
    expect(result.items[1].reference.selector.requestId).toBe(f.requestId + 3)
    expect(f.replyCount()).toBe(0)
  }
)

test('more than 32 unresolved cards still fail closed and preserve every pending request', async () => {
  const f = fixture()
  const requests = await captureQuestionHistory(f, Array<'pending'>(33).fill('pending'))
  await expect(readTaskInteractions(f.core, { address: f.address })).rejects.toThrow('TASK_INTERACTION_OBSERVATION_LIMIT')
  for (const pending of requests) expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${pending.requestId}`)).toBe(pending)
  expect(f.replyCount()).toBe(0)
})

test('all resolved history remains bounded and never invents an active question', async () => {
  const f = fixture()
  await captureQuestionHistory(f, Array<'resolved'>(40).fill('resolved'))
  const result = await readTaskInteractions(f.core, { address: f.address })
  expect(result.observationState).toBe('observed')
  expect(result.items).toHaveLength(32)
  expect(result.items.every(item => item.state === 'resolved')).toBe(true)
  expect(result.items[0].reference.selector.requestId).toBe(f.requestId + 8)
  expect(f.replyCount()).toBe(0)
})

test.each(['read', 'question', 'approval'] as const)(
  '%s keeps the original address when the caller edits it during task lookup', async operation => {
    const f = fixture(operation === 'approval' ? 'approval' : 'question')
    await f.capture()
    const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    const address = { ...f.address }
    let resume!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    vi.mocked(f.core.taskDescriptor).mockImplementationOnce(async params => {
      expect(params.address).toEqual(f.address)
      started()
      await new Promise<void>(resolve => { resume = resolve })
      return { taskId: f.taskId, task: f.task, server: f.server } as never
    })
    const pending = operation === 'read'
      ? readTaskInteractions(f.core, { address })
      : respondTaskInteraction(f.core, { address, response: {
          reference, answers: { choice: { answers: ['Continue'] } },
        } })
    const outcome = pending.then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error }))
    await waiting
    address.deviceId = 'new-target'
    address.threadId = 'new-thread'
    address.workspacePath = '/new-workspace'
    resume()
    const result = await outcome
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject(operation === 'read'
      ? { threadId: f.frame.threadId, observationState: 'observed' }
      : { reference, state: 'response_pending' })
    expect(f.replyCount()).toBe(operation === 'read' ? 0 : 1)
  }
)

test.each(['read', 'question', 'approval'] as const)(
  '%s cannot repair a mismatched original address by editing it during lookup', async operation => {
    const f = fixture(operation === 'approval' ? 'approval' : 'question')
    await f.capture()
    const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    const address = { ...f.address, workspacePath: '/another-original-workspace' }
    let resume!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    vi.mocked(f.core.taskDescriptor).mockImplementationOnce(async () => {
      started()
      await new Promise<void>(resolve => { resume = resolve })
      return { taskId: f.taskId, task: f.task, server: f.server } as never
    })
    const pending = operation === 'read'
      ? readTaskInteractions(f.core, { address })
      : respondTaskInteraction(f.core, { address, response: {
          reference, answers: { choice: { answers: ['Continue'] } },
        } })
    const outcome = pending.then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error }))
    await waiting
    address.workspacePath = f.address.workspacePath
    resume()
    const result = await outcome
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    expect(f.replyCount()).toBe(0)
    expect(f.pending.responsePending).toBeUndefined()
  }
)

async function captureReplacementWorkspace(f: ReturnType<typeof fixture>) {
  await f.capture()
  const replacement = { ...f.pending, requestId: f.requestId + 1, questionId: 'replacement-question' }
  f.core.pendingQuestionByKey.set(`${f.taskId}\0${replacement.requestId}`, replacement)
  f.task.workspacePath = '/replacement'
  await captureTaskInteraction(f.core, f.client, f.taskId, f.frame, replacement.requestId)
  const replacementAddress = { ...f.address, workspacePath: '/replacement' }
  const reference = (await readTaskInteractions(f.core, { address: replacementAddress })).items
    .find(item => item.reference.selector.requestId === replacement.requestId)!.reference
  f.task.workspacePath = f.address.workspacePath
  vi.mocked(f.client.request).mockClear()
  return { replacement, replacementAddress, reference }
}

test.each(['read', 'answer'] as const)(
  '%s cannot adopt a replacement workspace after the original address helper completes', async operation => {
    const f = fixture()
    const { replacement, replacementAddress, reference } = await captureReplacementWorkspace(f)

    let release!: () => void
    vi.mocked(f.core.taskDescriptor).mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ taskId: f.taskId, task: f.task, server: f.server } as never)
    }))
    const pending = operation === 'read'
      ? readTaskInteractions(f.core, { address: f.address })
      : respondTaskInteraction(f.core, { address: f.address, response: {
          reference, answers: { choice: { answers: ['Continue'] } },
        } })
    const outcome = pending.then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error }))
    release()
    // originalAddress checks the old path, then its caller resumes in a later
    // microtask. The same task ID now points at the already captured new card.
    await Promise.resolve()
    f.task.workspacePath = replacementAddress.workspacePath
    expect((await outcome).error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.replyCount()).toBe(0)
    expect(replacement.responsePending).toBeUndefined()

    // Explicitly visiting the replacement address still reads and answers its
    // own request; rejecting the stale address must not retire that waiter.
    expect(await readTaskInteractions(f.core, { address: replacementAddress }))
      .toMatchObject({ items: [{ reference, state: 'pending' }] })
    expect(await respondTaskInteraction(f.core, { address: replacementAddress, response: {
      reference, answers: { choice: { answers: ['Continue'] } },
    } })).toMatchObject({ state: 'response_pending' })
    expect(f.replyCount()).toBe(1)
  }
)


test('a status read cannot introduce another workspace after its first captured card becomes stale', async () => {
  const f = fixture()
  const { replacementAddress } = await captureReplacementWorkspace(f)
  let release!: () => void
  vi.mocked(f.client.request).mockImplementationOnce(async (_method, selector) => {
    await new Promise<void>(resolve => { release = resolve })
    return { ...selector, status: 'pending' } as never
  })
  const reading = readTaskInteractions(f.core, { address: f.address })
  await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledOnce())
  f.task.workspacePath = replacementAddress.workspacePath
  release()
  // A stale-address refresh must reject so the panel retains its disabled draft.
  await expect(reading).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  expect(f.client.request).toHaveBeenCalledOnce()
  expect(f.replyCount()).toBe(0)
  f.task.workspacePath = f.address.workspacePath
  await expect(readTaskInteractions(f.core, { address: f.address })).resolves.toMatchObject({
    items: [{ state: 'pending', reference: { selector: { requestId: f.requestId } } }],
  })
  expect(f.replyCount()).toBe(0)
})


function enlargeQuestion(f: ReturnType<typeof fixture>) {
  const questions = f.pending.renderPayload.questions as { question: string; options: { description: string }[] }[]
  // Each field remains within the native presentation contract. UTF-8 bytes,
  // rather than string length or card count, push the batch over its budget.
  questions[0].question = '题'.repeat(60000)
  for (const option of questions[0].options) option.description = '选'.repeat(16000)
}

test.each(['pending', 'response_pending', 'unknown', 'resolved'] as const)(
  'large resolved history cannot block the newest %s card below the count limit', async state => {
    const f = fixture()
    enlargeQuestion(f)
    const requests = await captureQuestionHistory(f, ['resolved', 'resolved', state])
    const result = await readTaskInteractions(f.core, { address: f.address })
    expect(result.observationState).toBe('observed')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ state, reference: { selector: { requestId: f.requestId + 2 } } })
    expect(result.items[0].presentation.questions[0].question).toBe('题'.repeat(60000))
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(512 * 1024)
    if (state === 'pending' || state === 'response_pending')
      expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${requests[2].requestId}`)).toBe(requests[2])
    expect(f.replyCount()).toBe(0)
    // Compaction affects only this read projection. A later native observation
    // must still reconcile every original receipt without replaying any answer.
    vi.mocked(f.client.request).mockClear()
    expect(await readTaskInteractions(f.core, { address: f.address })).toEqual(result)
    expect(f.client.request).toHaveBeenCalledTimes(3)
    expect(f.replyCount()).toBe(0)
  }
)

test('an oversized unresolved batch still fails without hiding or consuming either original question', async () => {
  const f = fixture()
  enlargeQuestion(f)
  const requests = await captureQuestionHistory(f, ['pending', 'pending'])
  await expect(readTaskInteractions(f.core, { address: f.address })).rejects.toThrow('TASK_INTERACTION_OBSERVATION_LIMIT')
  for (const pending of requests)
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${pending.requestId}`)).toBe(pending)
  expect(f.replyCount()).toBe(0)
})


test.each([undefined, 'Continue', 'continue-wire'])('compact question projection never changes an original option value (%s)', async value => {
  const f = fixture()
  const question = (f.pending.renderPayload.questions as Record<string, unknown>[])[0]
  const option = (question.options as Record<string, unknown>[])[0]
  if (value !== undefined) option.value = value
  await f.capture()
  const view = await readTaskInteractions(f.core, { address: f.address })
  if (value === 'continue-wire') {
    // V1 exposes labels only; the full original card retains richer options.
    expect(view).toMatchObject({ observationState: 'unknown', originalViewRequired: true, items: [] })
  } else {
    expect(view).toMatchObject({ observationState: 'observed', items: [{ state: 'pending' }] })
    expect(view.originalViewRequired).not.toBe(true)
  }
  expect(f.replyCount()).toBe(0)
})


test.each(['approval', 'question'] as const)(
  'replaying an original %s cannot move its pending object into a newer attempt', async kind => {
    const f = fixture(kind)
    await f.capture()
    const original = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    // Retries reuse turnId. The forwarder retains this exact original pending
    // object when its request is replayed after the new attempt has started.
    f.task.runtimeHandle.memoryTaskSnapshot.attemptId = 'retry-attempt'
    f.core.turnAttemptIds.set(`${f.taskId}:${f.frame.turnId}`, 'retry-attempt')
    await f.capture()
    const recovered = await readTaskInteractions(f.core, { address: f.address })
    expect(recovered.items).toHaveLength(1)
    expect(recovered.items[0]).toMatchObject({ reference: original, state: 'unknown' })
    expect(f.replyCount()).toBe(0)
    // A replay cannot manufacture a new original reply path for the stale card.
    const forged = structuredClone(original)
    forged.attemptId = 'retry-attempt'
    await expect(respondTaskInteraction(f.core, { address: f.address, response: {
      reference: forged, answers: { choice: { answers: ['Continue'] } },
    } })).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    expect(f.replyCount()).toBe(0)
    // The retry's genuinely new request still belongs to its new attempt.
    const requestId = f.requestId + 1
    const fresh = { ...f.pending, requestId,
      ...(kind === 'approval' ? { approvalId: 'retry-approval' } : { questionId: 'retry-question' }) }
    f.core.pendingQuestionByKey.set(`${f.taskId}\0${requestId}`, fresh)
    await captureTaskInteraction(f.core, f.client, f.taskId, f.frame, requestId)
    const freshView = await readTaskInteractions(f.core, { address: f.address })
    const current = freshView.items.find(item => item.reference.selector.requestId === requestId)!
    expect(current).toMatchObject({ state: 'pending', reference: { attemptId: 'retry-attempt' } })
    expect((await respondTaskInteraction(f.core, { address: f.address, response: {
      reference: current.reference, answers: { choice: { answers: ['Continue'] } },
    } })).state).toBe('response_pending')
    expect(f.replyCount()).toBe(1)
  }
)


test('the original pending attempt stays fixed while its first target lookup waits', async () => {
  const f = fixture()
  const paused = pauseTargetLookup(f, 1)
  const first = f.capture()
  await paused.waiting
  f.task.runtimeHandle.memoryTaskSnapshot.attemptId = 'retry-attempt'
  f.core.turnAttemptIds.set(`${f.taskId}:${f.frame.turnId}`, 'retry-attempt')
  await f.capture()
  paused.resume()
  await first
  expect(await readTaskInteractions(f.core, { address: f.address }))
    .toMatchObject({ observationState: 'unknown', originalViewRequired: true, items: [] })
  expect(f.replyCount()).toBe(0)
})

test('projection eviction cannot renew an old pending request under a retry attempt', async () => {
  const f = fixture()
  await f.capture()
  await captureQuestionHistory(f, Array<'resolved'>(257).fill('resolved'))
  f.core.pendingQuestionByKey.set(`${f.taskId}\0${f.requestId}`, f.pending)
  f.task.runtimeHandle.memoryTaskSnapshot.attemptId = 'retry-attempt'
  f.core.turnAttemptIds.set(`${f.taskId}:${f.frame.turnId}`, 'retry-attempt')
  vi.mocked(f.client.request).mockImplementation(async (_method, selector) => ({
    ...selector, status: selector.requestId === f.requestId ? 'pending' : 'resolved',
  }) as never)
  await f.capture()
  const view = await readTaskInteractions(f.core, { address: f.address })
  expect(view.originalViewRequired).toBe(true)
  expect(view.items.some(item => item.reference.selector.requestId === f.requestId)).toBe(false)
  expect(f.replyCount()).toBe(0)
})


test.each((['approval', 'question'] as const).flatMap(kind =>
  ['', ' \t', false, 7].map(workspacePath => [kind, workspacePath] as const)))(
  '%s rejects an explicitly unusable workspace address %j without reading or answering another binding', async (kind, workspacePath) => {
    const f = fixture(kind)
    await f.capture()
    const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
    vi.mocked(f.client.request).mockClear()
    const address = { ...f.address, workspacePath }
    await expect(readTaskInteractions(f.core, { address }))
      .rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    await expect(respondTaskInteraction(f.core, { address, response: {
      reference, answers: { choice: { answers: ['Continue'] } },
    } })).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.respond).not.toHaveBeenCalled()
    expect(f.pending.responsePending).not.toBe(true)
    // Rejecting a broken address leaves the original card available to its owner.
    await expect(respondTaskInteraction(f.core, { address: f.address, response: {
      reference, answers: { choice: { answers: ['Continue'] } },
    } })).resolves.toMatchObject({ state: 'response_pending' })
    expect(f.client.respond).toHaveBeenCalledOnce()
  }
)

test.each([undefined, null])('legacy omitted/null workspace paths remain supported: %j', async workspacePath => {
  const f = fixture()
  await f.capture()
  const address = { ...f.address, workspacePath }
  const snapshot = await readTaskInteractions(f.core, { address })
  expect(snapshot.items[0].state).toBe('pending')
  await expect(respondTaskInteraction(f.core, { address, response: {
    reference: snapshot.items[0].reference, answers: { choice: { answers: ['Continue'] } },
  } })).resolves.toMatchObject({ state: 'response_pending' })
  expect(f.client.respond).toHaveBeenCalledOnce()
})

test('blank custom selections cannot satisfy an original multi-select question', async () => {
  const f = fixture()
  Object.assign((f.pending.renderPayload.questions as Record<string, unknown>[])[0], { isOther: true, multiSelect: true })
  await f.capture()
  const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
  for (const blank of ['', ' \t\n', '\u0085', '\u3000']) {
    await expect(respondTaskInteraction(f.core, { address: f.address, response: {
      reference, answers: { choice: { answers: [blank] } },
    } })).rejects.toThrow('TASK_INTERACTION_INVALID_ANSWER')
    expect(f.pending.responsePending).not.toBe(true)
    expect(f.replyCount()).toBe(0)
  }
  const answers = { choice: { answers: ['  原任务的回答\n保留原文  '] } }
  await expect(respondTaskInteraction(f.core, { address: f.address, response: { reference, answers } }))
    .resolves.toMatchObject({ state: 'response_pending' })
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, expect.objectContaining({ answers }))
})

test('ordinary single-choice questions retain empty partial-answer compatibility', async () => {
  const f = fixture()
  Object.assign((f.pending.renderPayload.questions as Record<string, unknown>[])[0], { isOther: true })
  await f.capture()
  const reference = (await readTaskInteractions(f.core, { address: f.address })).items[0].reference
  await expect(respondTaskInteraction(f.core, { address: f.address, response: {
    reference, answers: { choice: { answers: [''] } },
  } })).resolves.toMatchObject({ state: 'response_pending' })
  expect(f.client.respond).toHaveBeenCalledOnce()
})

test.each(['refresh', 'answer'] as const)('an original card cannot %s after its task alias changes during status read', async operation => {
  const f = fixture()
  await f.capture()
  const alias = 'restored-task-alias'
  const address = { ...f.address, taskId: alias }
  let canonicalId = f.taskId
  f.core.resolveTaskId = id => id === alias ? canonicalId : id
  const reference = (await readTaskInteractions(f.core, { address })).items[0].reference
  let release!: () => void
  vi.mocked(f.client.request).mockImplementationOnce(async (_method, selector) => {
    await new Promise<void>(resolve => { release = resolve })
    return { ...selector, status: 'pending' } as never
  })

  const action = operation === 'refresh'
    ? readTaskInteractions(f.core, { address })
    : respondTaskInteraction(f.core, { address, response: { reference, answers: { choice: { answers: ['Continue'] } } } })
  const result = action.then(value => ({ value }), error => ({ error: error.message }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  // The previous canonical task and its client remain alive after the alias moves.
  canonicalId = 'replacement-task'
  release()

  expect(await result).toEqual({ error: 'TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE' })
  expect(f.replyCount()).toBe(0)
  expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
    items: [{ reference, state: 'pending' }],
  })
})
