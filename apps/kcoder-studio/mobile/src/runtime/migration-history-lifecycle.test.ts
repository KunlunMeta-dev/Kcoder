import { expect, it, vi } from 'vitest'
import { MobileMigrationClient } from './migration-client'
const requestId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',leaseId='33333333-3333-4333-8333-333333333333',archiveId=`archive-${'a'.repeat(64)}`
const lease={requestId,jobId,leaseId,archiveId,viewId:null,normalizationRevision:'foreign-records/5',sequence:1,state:'active',remainingMs:30_000,managedArchives:1,legacyArchives:0}
const retirement={operationId:requestId,jobId,archiveId,sequence:1,phase:'prepared',cancelRequested:false,cancelRevision:0,ownsArchive:true,logicalRetired:false,retainedReferences:0,collectedBytes:0,failureCode:null}
const caps={migrationHistoryViewV1:true,migrationArchiveRetirementV1:true}
function fixture(request=vi.fn(async()=>({lease})),capabilities=caps) {
  const journal={read:vi.fn(async()=>[]),put:vi.fn(async()=>{})}
  const client=new MobileMigrationClient(request,capabilities,journal,()=>true)
  return{client,journal,request}
}
const open={requestId,jobId,expectedArchiveId:archiveId,viewId:null}

it('idle view holds are transient and never create a durable migration intent',async()=>{
  const f=fixture()
  await f.client.call('historyViewOpen',open)
  f.request.mockResolvedValueOnce({lease:{...lease,sequence:2}})
  await f.client.call('historyViewRenew',{requestId,leaseId,expectedSequence:1})
  f.request.mockResolvedValueOnce({lease:{...lease,state:'released',remainingMs:0}})
  await f.client.call('historyViewRelease',{requestId,leaseId})
  expect(f.journal.put).not.toHaveBeenCalled()
  f.client.close();expect(f.request).toHaveBeenCalledTimes(3)
})

it('the transient gate blocks concurrent opens but releases after settlement so the same job can reopen',async()=>{
  let reply!:(value:unknown)=>void
  const request=vi.fn(async(method:string,params:unknown):Promise<unknown>=>{
    if(method.endsWith('/open')&&request.mock.calls.length===1)return new Promise(resolve=>{reply=resolve})
    const id=(params as {requestId:string}).requestId
    return {lease:{...lease,requestId:id,state:method.endsWith('/release')?'released':'active',remainingMs:method.endsWith('/release')?0:30_000}}
  })
  const f=fixture(request as never), next='44444444-4444-4444-8444-444444444444'
  const pending=f.client.call('historyViewOpen',open)
  await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
  await expect(f.client.call('historyViewOpen',{...open,requestId:next})).rejects.toThrow('operation_pending')
  expect(request).toHaveBeenCalledTimes(1)
  reply({lease});await pending
  await f.client.call('historyViewRelease',{requestId,leaseId})
  expect((await f.client.call('historyViewOpen',{...open,requestId:next})).lease?.state).toBe('active')
  expect(request).toHaveBeenCalledTimes(3)
  expect(f.journal.put).not.toHaveBeenCalled()
})

it('sequential renewals of the same transient hold do not leave a permanent mutation gate',async()=>{
  const f=fixture()
  await f.client.call('historyViewOpen',open)
  for(const expectedSequence of [1,2]){
    f.request.mockResolvedValueOnce({lease:{...lease,sequence:expectedSequence+1}})
    expect((await f.client.call('historyViewRenew',{requestId,leaseId,expectedSequence})).lease?.sequence).toBe(expectedSequence+1)
  }
  expect(f.journal.put).not.toHaveBeenCalled()
})

it('unknown view IDs cannot obtain a transport and missing capability remains explicit',async()=>{
  const f=fixture()
  await expect(f.client.call('historyViewRead',{requestId})).rejects.toThrow('scope_changed')
  expect(f.request).not.toHaveBeenCalled()
  const old=fixture(vi.fn(),{migrationHistoryViewV1:false,migrationArchiveRetirementV1:false})
  await expect(old.client.call('historyViewOpen',open)).rejects.toThrow('update_required')
  expect(old.request).not.toHaveBeenCalled()
})

it('late open after close clears only its validated original hold on the original request function',async()=>{
  let reply!:(value:unknown)=>void
  const request=vi.fn(async(method:string):Promise<unknown>=>method.endsWith('/open')?new Promise(resolve=>{reply=resolve}):{lease:{...lease,state:'released',remainingMs:0}})
  const f=fixture(request as never), replacement=vi.fn()
  const pending=f.client.call('historyViewOpen',open)
  await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
  f.client.close();reply({lease})
  await expect(pending).rejects.toThrow('scope_changed')
  expect(request).toHaveBeenLastCalledWith('migration/history/view/release',{requestId,leaseId})
  expect(replacement).not.toHaveBeenCalled()
  expect(f.journal.put).not.toHaveBeenCalled()
})

it('a mismatching view source is never adopted as a cleanup handle',async()=>{
  const f=fixture(vi.fn(async()=>({lease:{...lease,jobId:'unowned-peer'}})))
  await expect(f.client.call('historyViewOpen',open)).rejects.toThrow('invalid_response')
  f.client.close();expect(f.request).toHaveBeenCalledTimes(1)
})

it('retirement preserves unknown execution state and rejects a foreign source or oversized page',async()=>{
  const state={retirement,workerState:'unknown',workerScheduled:false,workerError:'external_history_retirement_execution_unknown'}
  const f=fixture(vi.fn(async()=>state) as never)
  expect((await f.client.call('retirementRead',{operationId:requestId,jobId})).workerState).toBe('unknown')
  f.request.mockResolvedValueOnce({ ...state,retirement:{...retirement,jobId:'foreign'} } as never)
  await expect(f.client.call('retirementRead',{operationId:requestId,jobId})).rejects.toThrow('invalid_response')
  f.request.mockResolvedValueOnce({items:Array(11).fill(state),nextCursor:null} as never)
  await expect(f.client.call('retirementList',{})).rejects.toThrow('invalid_response')
})
