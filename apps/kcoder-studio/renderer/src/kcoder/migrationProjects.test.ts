import { describe, it, expect, vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-projects.json'
import { PROJECTS_METHODS, validProjectCall } from '../../../shared/migrationProjects'
import { ProjectMappingController, ProjectTargetCatalogCache } from '../../../shared/migrationProjectMapping'
import { ProjectSourcesController } from '../../../shared/migrationProjectSources'
const copy = <T>(value: T): T => structuredClone(value)
const report = () => ({ jobId:'job',itemId:'item',pageIndex:0,fields:[{field:'source_root' as const,ordinal:0,value:'D:\\foreign-never-open',sourceRootId:'original-root'}],totalFields:1,nextPage:null,unobserved:[] })
const targets = () => ({targetCatalogId:'target-catalog',registeredWorkspacesObserved:true,pageIndex:0,items:[{targetHandle:'opaque-workspace',displayName:'User workspace',roots:1,currentWorkspace:true}],totalItems:1,nextPage:null})
const roots = (trusted=true) => ({targetCatalogId:'target-catalog',targetHandle:'opaque-workspace',pageIndex:0,roots:[{targetRootHandle:'opaque-root',path:'/target-not-source',ordinal:0,trusted,available:true}],totalRoots:1,nextPage:null})
const api = () => ({ projectReport:vi.fn(async()=>report()), projectTargets:vi.fn(async()=>targets()),projectTargetRoots:vi.fn(async()=>roots()),projectsDiscover:vi.fn(),projectsSources:vi.fn(),projectSourceRoots:vi.fn() })

describe('project inventory identity and explicit mapping',()=>{
  it('rejects missing/wrong replies, peer catalogs, duplicate rows and a false complete claim',()=>{
    const params={source:'codex' as const},result=copy(examples.MigrationProjectSourcesResult[0].value)
    expect(validProjectCall(PROJECTS_METHODS.discover,params,result)).toBe(true)
    for(const row of [undefined,{...result,source:'claude-code'},{...result,items:[result.items[0],result.items[0]],totalItems:2},
      {...result,nextPage:1},{...result,formatRevision:null},{...result,privateToken:'PRIVATE'}]) expect(validProjectCall(PROJECTS_METHODS.discover,params,row)).toBe(false)
    expect(validProjectCall(PROJECTS_METHODS.sources,{catalogId:'peer',pageIndex:0},result)).toBe(false)
  })
  it('does not turn foreign roots into target authority; fresh trust and complete explicit mapping are required',async()=>{
    const calls=api(),model=new ProjectMappingController(calls,()=>true,()=>true,()=> 'failed')
    await model.load('job','item');expect(model.choice('item')).toBeNull()
    await model.selectTarget('opaque-workspace');expect(model.choice('item')).toBeNull()
    model.map('original-root','D:\\foreign-never-open');expect(model.choice('item')).toBeNull()
    model.map('original-root','opaque-root');expect(model.choice('item')).toEqual({kind:'project',itemId:'item',mapping:{targetCatalogId:'target-catalog',targetHandle:'opaque-workspace',mappings:[{sourceRootId:'original-root',targetRootHandle:'opaque-root'}]}})
    expect(calls.projectTargets).toHaveBeenCalledWith({pageIndex:0},expect.anything())
    expect(JSON.stringify(calls.projectTargets.mock.calls)).not.toContain('foreign')
    calls.projectTargetRoots.mockResolvedValueOnce(roots(false));await model.selectTarget('opaque-workspace');model.map('original-root','opaque-root');expect(model.choice('item')).toBeNull()
  })
  it('rejects late target metadata after owner disposal and keeps reports readable without a live target catalog',async()=>{
    const calls=api();let finish!:(value:ReturnType<typeof targets>)=>void
    calls.projectTargets.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const model=new ProjectMappingController(calls,()=>true,()=>true,()=> 'failed'),loading=model.load('job','item')
    await Promise.resolve();model.dispose();finish(targets());await loading;expect(model.choice('item')).toBeNull()
    const reader=new ProjectMappingController(calls,()=>true,()=>true,()=> 'failed');await reader.load('job','item',false)
    expect(reader.snapshot().report).toEqual(report().fields);expect(calls.projectTargets).toHaveBeenCalledTimes(1)
  })
  it('retains cross-page handles in one catalog and never blindly repeats an unknown batch creation',async()=>{
    const base=copy(examples.MigrationProjectSourcesResult[0].value)
    const first={...base,items:Array.from({length:10},(_,i)=>({...base.items[0],sourceHandle:`row-${i}`})),totalItems:11,nextPage:1}
    const second={...base,pageIndex:1,items:[{...base.items[0],sourceHandle:'row-10'}],totalItems:11,nextPage:null}
    const calls={discover:vi.fn(async()=>first),page:vi.fn(async()=>second),prepare:vi.fn(async()=>{throw new Error('ack lost')})}
    const model=new ProjectSourcesController(calls,()=>true);model.configure('codex');await model.discover();model.select('row-0');await model.page(1);model.select('row-10');await model.prepare();await model.prepare()
    expect(calls.prepare).toHaveBeenCalledTimes(1);expect(calls.prepare.mock.calls[0][0]).toEqual([{catalogId:base.catalogId,sourceHandle:'row-0'},{catalogId:base.catalogId,sourceHandle:'row-10'}]);expect(model.snapshot().unknown).toBe(true)
    const clean=new ProjectSourcesController(calls,()=>true);await clean.discover();clean.select('row-0');calls.page.mockResolvedValueOnce({...second,catalogId:'peer'});await clean.page(1);expect(clean.snapshot().selected).toEqual([])
  })
})


it('one original batch reuses its readonly target catalog across all selected project items',async()=>{
 const calls=api(),catalog=new ProjectTargetCatalogCache('owned-batch')
 for(let i=0;i<64;i++){
  const model=new ProjectMappingController(calls,()=>true,()=>true,()=> 'failed',catalog)
  await model.load('job','item');model.dispose()
 }
 expect(calls.projectTargets.mock.calls.filter(([input])=>!('targetCatalogId' in input))).toHaveLength(1)
 expect(calls.projectTargets.mock.calls.slice(1).every(([input])=>input.targetCatalogId==='target-catalog')).toBe(true)
 catalog.reset();await new ProjectMappingController(calls,()=>true,()=>true,()=> 'failed',catalog).load('job','item')
 expect(calls.projectTargets.mock.calls.filter(([input])=>!('targetCatalogId' in input))).toHaveLength(2)
})
