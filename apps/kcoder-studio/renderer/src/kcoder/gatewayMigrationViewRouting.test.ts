import { expect, test, vi } from 'vitest'
import { requestNativeMigration } from './gatewayMigration'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { notifyAccountContextChange } from './accountContextEvents'

function fixture() {
  const requestId='11111111-1111-4111-8111-111111111111', jobId='22222222-2222-4222-8222-222222222222', leaseId='33333333-3333-4333-8333-333333333333', archiveId=`archive-${'a'.repeat(64)}`
  const lease = { requestId, jobId, leaseId, archiveId, viewId:null, normalizationRevision:'vendor-jsonl/4', sequence:1, state:'active', remainingMs:30_000, managedArchives:1, legacyArchives:0 }
  const client = Object.assign(new EventTarget(), {
    diagnosticConnection:{connectionId:'original',targetId:'owned'},
    request:vi.fn(async()=>{throw new Error('ordinary request would reconnect')}),
    requestOnConnection:vi.fn(async()=>({lease})), supportsExperimental:()=>true,
  })
  const target={id:'owned',runtime:'kcoder',transport:'local',workspacePath:'/owned'}
  const core={disposed:false,serverForParams:vi.fn(async()=>target),commandClient:vi.fn(async()=>client)} as unknown as GatewayRuntimeCore
  const open={deviceId:'owned',workspacePath:'/owned',method:'migration/history/view/open',params:{requestId,jobId,expectedArchiveId:archiveId,viewId:null}}
  const release={...open,method:'migration/history/view/release',params:{requestId,leaseId}}
  return {client,core,open,release,lease}
}

test('known view operations stay on their original client without resolving any new target', async()=>{
  const f=fixture(); await requestNativeMigration.call(f.core,f.open)
  vi.mocked(f.core.serverForParams).mockClear().mockRejectedValue(new Error('replacement target'))
  vi.mocked(f.core.commandClient).mockClear()
  f.client.requestOnConnection.mockResolvedValue({lease:{...f.lease,state:'released',remainingMs:0}})
  await requestNativeMigration.call(f.core,f.release)
  expect(f.client.requestOnConnection).toHaveBeenLastCalledWith('original',f.release.method,f.release.params,undefined)
  expect(f.core.serverForParams).not.toHaveBeenCalled(); expect(f.core.commandClient).not.toHaveBeenCalled()
  expect(f.client.request).not.toHaveBeenCalled()
  f.client.dispatchEvent(new Event('close'))
})

test.each(['close','socket','account'])('a %s change sends no cleanup or renewal to any replacement target',async kind=>{
  const f=fixture(); await requestNativeMigration.call(f.core,f.open)
  f.client.requestOnConnection.mockClear(); vi.mocked(f.core.serverForParams).mockClear(); vi.mocked(f.core.commandClient).mockClear()
  if(kind==='close') f.client.dispatchEvent(new Event('close'))
  else if(kind==='socket') f.client.diagnosticConnection.connectionId='replacement'
  else notifyAccountContextChange('owned')
  await expect(requestNativeMigration.call(f.core,f.release)).rejects.toThrow('connection_changed')
  expect(f.client.requestOnConnection).not.toHaveBeenCalled(); expect(f.client.request).not.toHaveBeenCalled()
  expect(f.core.serverForParams).not.toHaveBeenCalled(); expect(f.core.commandClient).not.toHaveBeenCalled()
  f.client.dispatchEvent(new Event('close'))
})

test('a late open after account change cannot certify the new context',async()=>{
  const f=fixture(); let done!:(value:{lease:typeof f.lease})=>void
  f.client.requestOnConnection.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve}))
  const pending=requestNativeMigration.call(f.core,f.open)
  await vi.waitFor(()=>expect(f.client.requestOnConnection).toHaveBeenCalledTimes(1))
  notifyAccountContextChange('owned'); done({lease:f.lease})
  await expect(pending).rejects.toThrow('connection_changed')
  expect(f.client.request).not.toHaveBeenCalled(); expect(f.client.requestOnConnection).toHaveBeenCalledTimes(1)
  f.client.dispatchEvent(new Event('close'))
})
