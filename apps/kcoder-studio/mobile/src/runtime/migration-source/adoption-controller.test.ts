import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MigrationSourceAdoptionController } from './adoption-controller'
import { TestStorage } from './test-storage'
import type { GatewayProfile } from '@/gateway/types'
import type { MigrationSourceAdoptionPrepareParams, MigrationSourceAdoptionState, MigrationSourceReceivedItem } from '../../../../shared/generated/contracts'

const fake=vi.hoisted(()=>({fetcher:null as any,allowed:true}))
vi.mock('@/storage/workspace-profile-fence',()=>({captureWorkspaceProfileIdentity:(value:any)=>value.id,startWorkspaceProfileRpc:async(_identity:string,send:()=>Promise<unknown>)=>{if(!fake.allowed)throw new Error('revoked');return{response:send()}}}))
vi.mock('@/gateway/http',()=>({gatewayRequest:async(_profile:unknown,path:string,init:RequestInit,limits:{beforeDispatch():void})=>{await Promise.resolve();limits.beforeDispatch();return(await fake.fetcher(path,init)).json()}}))
let localStorage:TestStorage

const requestId='11111111-1111-4111-8111-111111111111'
const target={id:'target',workspacePath:'/owned/workspace'}
const profile={id:'owned',baseUrl:'https://owned.invalid'} as GatewayProfile
const receipt={requestId,manifestSha256:'a'.repeat(64),entries:70,bytes:700}
const item=(index:number):MigrationSourceReceivedItem=>({entryId:`e${String(index).padStart(4,'0')}-0000`,source:'codex',class:'configuration',category:null,files:1,bytes:10,projectScoped:false})
const json=(value:unknown)=>new Response(JSON.stringify(value))
function nativeState(input:MigrationSourceAdoptionPrepareParams,patch:Partial<MigrationSourceAdoptionState>={}):MigrationSourceAdoptionState{
  return{requestId,adoptionId:input.locator.adoptionId,phase:'preview_ready',totalSources:input.selections.length,completedSources:input.selections.length,blockedItems:0,
    control:{sequence:1,cancelWatermark:0},cancelRequested:false,workerState:'stopped',errorCode:null,
    jobs:[{jobId:`mig-${'b'.repeat(32)}`,source:'codex',targetScope:'user',previewReady:true}],...patch}
}
function fixture(rows=Array.from({length:13},(_,index)=>item(index)),selectedTarget:{id:string;workspacePath?:string}=target){
  let input:MigrationSourceAdoptionPrepareParams|null=null
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{
    const body=JSON.parse(String(init?.body))
    if(String(url).endsWith('/open'))return json({status:'ready',launching:false,ownedChildren:1})
    if(String(url).endsWith('/close'))return json({status:'released'})
    if(String(url).endsWith('/received'))return json({receipt,items:rows.slice(body.pageIndex*10,body.pageIndex*10+10),totalSources:rows.length,nextPage:(body.pageIndex+1)*10<rows.length?body.pageIndex+1:null})
    if(String(url).endsWith('/adoption-prepare')){input=body;return json({state:nativeState(body)})}
    return json({state:input?nativeState(input):null})
  })
  fake.fetcher=fetcher
  const model=new MigrationSourceAdoptionController({target:selectedTarget,receipt,isCurrent:()=>true,profile,scope:'owned',storage:localStorage})
  return{model,fetcher,get input(){return input},newController:()=>new MigrationSourceAdoptionController({target:selectedTarget,receipt,isCurrent:()=>true,profile,scope:'owned',storage:localStorage})}
}
beforeEach(()=>{localStorage=new TestStorage();fake.allowed=true})
afterEach(()=>{vi.useRealTimers()})

it('opens no resources until explicit reading, pages ten and persists the ID before one preview prepare',async()=>{
  const f=fixture()
  expect(f.fetcher).not.toHaveBeenCalled()
  await f.model.load();expect(f.model.snapshot().page?.items).toHaveLength(10)
  f.model.select(item(0).entryId,true);await f.model.load(1);f.model.select(item(12).entryId,true)
  expect(f.model.snapshot().selected).toHaveLength(2)
  const original=f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async(url,init)=>{
    if(String(url).endsWith('/adoption-prepare'))expect(localStorage.length).toBe(1)
    return original(url,init)
  })
  await f.model.prepare()
  expect(f.input?.selections).toEqual([{entryId:item(0).entryId},{entryId:item(12).entryId}])
  expect(f.model.snapshot().result?.state?.phase).toBe('preview_ready')
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/adoption-prepare'))).toHaveLength(1)
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/open')).map(call=>JSON.parse(String(call[1]?.body)).purpose)).toEqual(['target_recovery'])
  f.model.dispose()
})

it('requires explicit current-workspace mapping for configuration/assets but never maps historical provenance',async()=>{
  const rows=[{...item(0),projectScoped:true},{...item(1),class:'work_asset' as const,category:'skill' as const,projectScoped:true},{...item(2),class:'history' as const,projectScoped:true}]
  const f=fixture(rows);await f.model.load()
  for(const row of rows)f.model.select(row.entryId,true)
  expect(f.model.canPrepare()).toBe(false)
  f.model.map(rows[0].entryId,true);f.model.map(rows[1].entryId,true);f.model.map(rows[2].entryId,true)
  expect(f.model.canPrepare()).toBe(true);await f.model.prepare()
  expect(f.input?.selections).toEqual([{entryId:rows[0].entryId,projectMapping:'current_workspace'},{entryId:rows[1].entryId,projectMapping:'current_workspace'},{entryId:rows[2].entryId}])
  const noWorkspace=fixture(rows,{...target,workspacePath:undefined});await noWorkspace.model.load()
  noWorkspace.model.select(rows[0].entryId,true);noWorkspace.model.map(rows[0].entryId,true)
  await noWorkspace.model.prepare();expect(noWorkspace.model.snapshot().error).toBe('source_transfer_project_mapping_required')
  expect(noWorkspace.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-prepare'))).toBe(false)
  f.model.dispose();noWorkspace.model.dispose()
})

it('keeps at most 64 explicit references across pages',async()=>{
  const f=fixture(Array.from({length:70},(_,i)=>item(i)))
  for(let page=0;page<7;page++){await f.model.load(page);for(const row of f.model.snapshot().page!.items)f.model.select(row.entryId,true)}
  expect(f.model.snapshot().selected).toHaveLength(64);await f.model.prepare();expect(f.input?.selections).toHaveLength(64)
  f.model.dispose()
})

it('reopens a lost prepare receipt with the same ID and only reads, even if a new chooser nonce was allocated',async()=>{
  const f=fixture();await f.model.load();f.model.select(item(0).entryId,true)
  const original=f.fetcher.getMockImplementation()!
  let lost:MigrationSourceAdoptionPrepareParams|null=null
  f.fetcher.mockImplementation(async(url,init)=>{
    if(String(url).endsWith('/adoption-prepare')){lost=JSON.parse(String(init?.body));throw new Error('lost reply')}
    return original(url,init)
  })
  await f.model.prepare();expect(f.model.snapshot().error).toBe('source_transfer_outcome_unknown')
  const originalId=f.model.snapshot().input!.locator.adoptionId;expect(lost).not.toBeNull();f.model.dispose()
  const reopened=f.newController();await reopened.load();reopened.select(item(0).entryId,true);await reopened.prepare()
  expect(reopened.snapshot().input?.locator.adoptionId).toBe(originalId)
  expect(reopened.snapshot().result).toEqual({state:null})
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/adoption-prepare'))).toHaveLength(1)
  expect(f.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-read'))).toBe(true)
  reopened.dispose()
})

it('never rebuilds a corrupt persisted intent or invents stopped control from an unknown observation',async()=>{
  const f=fixture();await f.model.load();f.model.select(item(0).entryId,true);await f.model.prepare()
  const input=f.model.snapshot().input!
  f.fetcher.mockResolvedValueOnce(json({state:nativeState(input,{phase:'unknown',workerState:'unknown',control:null,cancelRequested:null})}))
  await f.model.read()
  const value=f.model.snapshot().result!.state!;expect(value.control).toBeNull()
  await f.model.operate('resume',value)
  expect(f.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-resume'))).toBe(false)
  f.model.dispose()
  localStorage.setItem(localStorage.key(0)!,'{')
  const reopened=f.newController();await reopened.load();reopened.select(item(0).entryId,true);await reopened.prepare()
  expect(reopened.snapshot().error).toBe('source_transfer_adoption_recovery_invalid')
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/adoption-prepare'))).toHaveLength(1)
  reopened.dispose()
})

it('rejects stale resume watermarks and does not dispatch control after the account/view scope changes',async()=>{
  const f=fixture();await f.model.load();f.model.select(item(0).entryId,true);await f.model.prepare()
  const value=f.model.snapshot().result!.state!
  f.fetcher.mockResolvedValueOnce(json({state:nativeState(f.model.snapshot().input!,{phase:'cancelled',control:{sequence:3,cancelWatermark:2},cancelRequested:true})}))
  await f.model.operate('resume',value)
  expect(f.model.snapshot().error).toBe('source_transfer_adoption_stale_control')
  expect(f.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-resume'))).toBe(false)
  f.model.dispose()
  let current=true,finish!:(value:Response)=>void
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async url=>String(url).endsWith('/open')?new Promise(resolve=>{finish=resolve}):json({status:'released'}))
  fake.fetcher=fetcher
  const changed=new MigrationSourceAdoptionController({target,receipt,isCurrent:()=>current,profile,scope:'owned',storage:localStorage})
  const pending=changed.load();await vi.waitFor(()=>expect(fetcher.mock.calls.some(call=>String(call[0]).endsWith('/open'))).toBe(true));current=false;finish(json({status:'ready',launching:false,ownedChildren:1}));await pending
  expect(fetcher.mock.calls.some(call=>String(call[0]).endsWith('/received')||String(call[0]).endsWith('/adoption-prepare'))).toBe(false)
  expect(fetcher.mock.calls.slice(1).every(call=>JSON.parse(String(call[1]?.body)).targetId==='target')).toBe(true)
  changed.dispose()
})

it('cleans a pending open reply on its original recovery session after the panel closes',async()=>{
  let finish!:(value:Response)=>void
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async url=>String(url).endsWith('/open')?new Promise(resolve=>{finish=resolve}):json({status:'released'}))
  fake.fetcher=fetcher
  const model=new MigrationSourceAdoptionController({target,receipt,isCurrent:()=>true,profile,scope:'owned',storage:localStorage})
  const pending=model.load();await vi.waitFor(()=>expect(fetcher.mock.calls.some(call=>String(call[0]).endsWith('/open'))).toBe(true));model.dispose();finish(json({status:'ready',launching:false,ownedChildren:1}));await pending
  const original=JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  await vi.waitFor(()=>expect(fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/close'))).toHaveLength(2))
  for(const call of fetcher.mock.calls.slice(1))expect(JSON.parse(String(call[1]?.body))).toEqual(original)
})

it('cannot send cleanup through a revoked account profile',async()=>{
  const f=fixture();await f.model.load();const previous=f.fetcher.mock.calls.length
  fake.allowed=false
  f.model.dispose();await Promise.resolve();await Promise.resolve()
  expect(f.fetcher).toHaveBeenCalledTimes(previous)
})

it('requires an explicit per-item scoped-instruction mapping and preserves changed mapping identities',async()=>{
  const row={...item(0),class:'instructions' as const,category:'instructions' as const,projectScoped:true}
  const f=fixture([row]);await f.model.load();f.model.select(row.entryId,true);f.model.map(row.entryId,true)
  expect(f.model.canPrepare()).toBe(false)
  await f.model.prepare();expect(f.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-prepare'))).toBe(false)
  const mapping={entryId:row.entryId,items:[{itemId:'instruction-0',targetRelativeScope:''}],archiveIncompleteChain:false}
  f.model.mapInstructions(mapping);expect(f.model.canPrepare()).toBe(true);await f.model.prepare()
  const original=f.model.snapshot().input!.locator.adoptionId
  expect(f.input?.instructionMappings).toEqual([mapping])
  f.model.mapInstructions({...mapping,items:[{itemId:'instruction-0',targetRelativeScope:'src'}]});await f.model.prepare()
  expect(f.model.snapshot().input!.locator.adoptionId).not.toBe(original)
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/adoption-prepare'))).toHaveLength(2)
  const changed=f.model.snapshot().input!.locator.adoptionId;f.model.dispose()
  const reopened=f.newController();await reopened.load();reopened.select(row.entryId,true);reopened.map(row.entryId,true)
  reopened.mapInstructions({...mapping,items:[{itemId:'instruction-0',targetRelativeScope:'src'}]});await reopened.prepare()
  expect(reopened.snapshot().input?.locator.adoptionId).toBe(changed)
  expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith('/adoption-prepare'))).toHaveLength(2)
  reopened.dispose()
})

it('rejects traversal and foreign-entry instruction mappings before preparing anything',async()=>{
  const row={...item(0),class:'instructions' as const,category:'instructions' as const,projectScoped:true}
  const f=fixture([row]);await f.model.load();f.model.select(row.entryId,true);f.model.map(row.entryId,true)
  f.model.mapInstructions({entryId:item(1).entryId,items:[{itemId:'instruction-0',targetRelativeScope:''}]})
  expect(f.model.snapshot().instructionMappings).toHaveLength(0)
  f.model.mapInstructions({entryId:row.entryId,items:[{itemId:'instruction-0',targetRelativeScope:'../outside'}]})
  expect(f.model.canPrepare()).toBe(false);await f.model.prepare()
  expect(f.fetcher.mock.calls.some(call=>String(call[0]).endsWith('/adoption-prepare'))).toBe(false)
  f.model.dispose()
})
