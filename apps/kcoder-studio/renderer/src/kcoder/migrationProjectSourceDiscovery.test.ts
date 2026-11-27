import { beforeEach,afterEach,it,expect,vi } from 'vitest'
import { MigrationProjectSourceDiscovery } from './migrationProjectSourceDiscovery'
const {client}=vi.hoisted(()=>({client:{open:vi.fn(),query:vi.fn(),close:vi.fn(),selectDirectory:vi.fn()}}))
vi.mock('./gatewayMigrationSourceSessions',async original=>({...await original<typeof import('./gatewayMigrationSourceSessions')>(),createMigrationSourceSessionClient:()=>client}))
const page=(index=0)=>({catalogId:'owned-catalog',source:'codex',pageIndex:index,items:Array.from({length:index?3:10},(_,i)=>({sourceHandle:`row-${index*10+i}`,displayName:`Original ${index*10+i}`,labelOrigin:'registry_name',originalProjectId:`native-${index*10+i}`,roots:1,position:index*10+i,sourceCreatedAtMs:null,sourceUpdatedAtMs:null})),totalItems:13,nextPage:index?null:1,knownRowsComplete:true,formatRevision:'codex-project-registry/sqlite/1',unobserved:['source_trust'],problems:[]})
beforeEach(()=>{vi.clearAllMocks();client.open.mockResolvedValue({status:'ready'});client.close.mockResolvedValue({status:'released'});client.query.mockResolvedValue(page())})
afterEach(()=>{delete window.__KCODER_STUDIO_RUNTIME_CONFIG__})
it('retains only explicit same-catalog handles across ten-item pages and clears invalidated catalogs',async()=>{
 const model=new MigrationProjectSourceDiscovery('source',undefined,()=>true);await model.discover('codex');model.select('row-0',true)
 client.query.mockResolvedValueOnce(page(1));await model.changePage('next');model.select('row-12',true)
 await expect(model.selections()).resolves.toEqual([{kind:'projects',catalogId:'owned-catalog',sourceHandle:'row-0'},{kind:'projects',catalogId:'owned-catalog',sourceHandle:'row-12'}])
 client.query.mockResolvedValueOnce({...page(),catalogId:'changed'});await model.changePage('previous');expect(model.snapshot().selected).toEqual([]);expect(model.snapshot().page).toBeNull();model.dispose()
})
it('a late open cleans only its original child and never reads a new target',async()=>{
 let done!:(v:unknown)=>void;client.open.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve}))
 const model=new MigrationProjectSourceDiscovery('source',undefined,()=>true),opening=model.discover('codex');await vi.waitFor(()=>expect(done).toBeTypeOf('function'))
 const original=client.open.mock.calls[0][0];model.dispose();done({status:'ready'});await opening
 expect(client.query).not.toHaveBeenCalled();expect(client.close.mock.calls.every(([value])=>value===original)).toBe(true)
})
