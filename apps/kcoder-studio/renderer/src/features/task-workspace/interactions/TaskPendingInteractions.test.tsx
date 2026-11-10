import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'
const f=vi.hoisted(()=>({request:vi.fn(),current:()=>true}))
vi.mock('@/host/localExecutor',()=>({requestLocalExecutor:f.request}))
const t=(key:string)=>key
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t})}))
vi.mock('@/kcoder/usePluginTargetScope',()=>({usePluginTargetScope:(deviceId:string)=>({key:deviceId,isCurrent:f.current})}))
const address={deviceId:'native',taskId:'actual-task',threadId:'original-thread',workspacePath:'/owned'}
const snapshot:TaskInteractionSnapshotV1={schemaVersion:1,threadId:address.threadId,observationState:'observed',items:[{
  reference:{attemptId:'actual-attempt',selector:{serverId:'native-process',threadId:address.threadId,turnId:'original-turn',requestId:2000001,appServerEpoch:'native-epoch',kind:'question',questionId:'question-2000001'}},state:'pending',
  presentation:{approval:null,questions:[{id:'choice',header:'Original task question',question:'Choose for the original parent only',isOther:false,options:[{label:'Use original source',description:'Original target data'},{label:'Stop here',description:'Do not continue'}]}]},
}]}
afterEach(()=>{cleanup();f.request.mockReset();vi.useRealTimers()})
test('the normal card responds using its original full reference and waits for native confirmation',async()=>{
  f.request.mockImplementation(async(method,params)=>method.endsWith('.read')?snapshot:{reference:params.response.reference,state:'response_pending'})
  render(<TaskPendingInteractions address={address}/>)
  await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('Use original source',{exact:true}))
  await screen.findByText('states.response_pending')
  expect(f.request).toHaveBeenCalledWith('runtime.tasks.interactions.respond',{
    address,response:{reference:snapshot.items[0].reference,answers:{choice:{answers:['Use original source']}}},
  },{signal:expect.any(AbortSignal)})
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  expect(screen.queryByText('states.resolved')).toBeNull()
})
test('lost response ACK stays unknown after a pending read and cannot submit again',async()=>{
  f.request.mockImplementation(async(method)=>{if(method.endsWith('.read'))return snapshot;throw new Error('Lost response ACK')})
  render(<TaskPendingInteractions address={address}/>)
  await screen.findByTestId('request-user-input-card');fireEvent.click(screen.getByText('Use original source',{exact:true}))
  await screen.findByText('states.unknown')
  fireEvent.click(screen.getByRole('button',{name:'refresh'}))
  await waitFor(()=>expect(f.request.mock.calls.filter(([method])=>method.endsWith('.read')).length).toBeGreaterThan(1))
  expect(screen.queryByTestId('request-user-input-card')).toBeNull()
  expect(f.request.mock.calls.filter(([method])=>method.endsWith('.respond'))).toHaveLength(1)
})
test('a target switch discards delayed original cards, while missing records remain unknown rather than empty',async()=>{
  let release!:(value:unknown)=>void
  f.request.mockImplementation(async(_method,params)=>params.address.deviceId==='native'?new Promise(resolve=>{release=resolve}):{schemaVersion:1,threadId:'other-thread',observationState:'unknown',items:[]})
  const view=render(<TaskPendingInteractions address={address}/>);await waitFor(()=>expect(release).toBeTypeOf('function'))
  view.rerender(<TaskPendingInteractions address={{...address,deviceId:'other',threadId:'other-thread'}}/>)
  await act(async()=>release(snapshot))
  await screen.findByText('unknown')
  expect(screen.queryByTestId('request-user-input-card')).toBeNull();expect(screen.queryByText('empty')).toBeNull()
})
test('approval cards reuse the normal permission presentation and fixed native decision labels',async()=>{
  const value=structuredClone(snapshot),row=value.items[0];row.reference.selector.kind='approval';delete row.reference.selector.questionId;row.reference.selector.approvalId='approval-2000001'
  row.presentation.approval={kind:'tool',subject:'FileWrite',input:'{"path":"owned.txt"}',reason:'Original controlled write'}
  row.presentation.questions[0].options=[{label:'Allow once',description:'Allow once for this operation'},{label:'Decline',description:'Decline this operation'}]
  f.request.mockImplementation(async(method,params)=>method.endsWith('.read')?value:{reference:params.response.reference,state:'response_pending'})
  render(<TaskPendingInteractions address={address}/>);await screen.findByTestId('permission-approval-content')
  expect(screen.getByText('FileWrite')).toBeInTheDocument()
  fireEvent.click(screen.getByText('approvalUi.allowOnce',{exact:true}))
  await waitFor(()=>expect(f.request.mock.calls.some(([method,params])=>method.endsWith('.respond')&&params.response.answers.choice.answers[0]==='Allow once')).toBe(true))
})
test('multiple selected values stay on one original question response without automatic option submission',async()=>{
  const value=structuredClone(snapshot);value.items[0].presentation.questions[0].multiSelect=true
  f.request.mockImplementation(async(method,params)=>method.endsWith('.read')?value:{reference:params.response.reference,state:'response_pending'})
  render(<TaskPendingInteractions address={address}/>)
  await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('Use original source',{exact:true}));fireEvent.click(screen.getByText('Stop here',{exact:true}))
  expect(f.request.mock.calls.filter(([method])=>method.endsWith('.respond'))).toHaveLength(0)
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(()=>expect(f.request.mock.calls.filter(([method])=>method.endsWith('.respond'))).toHaveLength(1))
  expect(f.request.mock.calls.find(([method])=>method.endsWith('.respond'))?.[1]).toMatchObject({response:{reference:value.items[0].reference,answers:{choice:{answers:['Use original source','Stop here']}}}})
})
test('an unsupported original presentation provides its exact parent navigation instead of an invented response path',async()=>{
  f.request.mockResolvedValue({schemaVersion:1,threadId:address.threadId,observationState:'unknown',items:[],originalViewRequired:true})
  const open=vi.fn();render(<TaskPendingInteractions address={address} onOpenParent={open}/>)
  await screen.findByTestId('task-interaction-original-required')
  expect(screen.queryByTestId('request-user-input-card')).toBeNull()
  fireEvent.click(screen.getByTestId('task-interaction-open-parent'));expect(open).toHaveBeenCalledExactlyOnceWith(address)
  expect(f.request.mock.calls.some(([method])=>method.endsWith('.respond'))).toBe(false)
})

test('refreshing original receipts keeps the in-flight answer transport alive', async () => {
  let finishAnswer!: () => void
  let answerSignal!: AbortSignal
  f.request.mockImplementation(async (method, params, options) => {
    if (method.endsWith('.read')) return snapshot
    answerSignal = options.signal
    return new Promise(resolve => {
      finishAnswer = () => resolve({ reference: params.response.reference, state: 'response_pending' })
    })
  })
  render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('Use original source', { exact: true }))
  await waitFor(() => expect(finishAnswer).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(f.request.mock.calls.filter(([method]) => method.endsWith('.read'))).toHaveLength(2))
  expect(answerSignal.aborted).toBe(false)
  await act(async () => finishAnswer())
  await screen.findByText('states.response_pending')
  expect(screen.queryByText('states.unknown')).toBeNull()
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})

test('leaving the original task still aborts its in-flight answer transport', async () => {
  let answerSignal!: AbortSignal
  f.request.mockImplementation(async (method, _params, options) => {
    if (method.endsWith('.read')) return snapshot
    answerSignal = options.signal
    return new Promise(() => {})
  })
  const view = render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('Use original source', { exact: true }))
  await waitFor(() => expect(answerSignal).toBeInstanceOf(AbortSignal))
  view.unmount()
  expect(answerSignal.aborted).toBe(true)
})
