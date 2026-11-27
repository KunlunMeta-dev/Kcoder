import { act,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { beforeEach,it,expect,vi } from 'vitest'
import { MigrationProjectMapping } from './MigrationProjectMapping'
const { api,register }=vi.hoisted(()=>({api:{projectReport:vi.fn(),projectTargets:vi.fn(),projectTargetRoots:vi.fn()},register:vi.fn()}))
vi.mock('@/kcoder/gatewayMigration',()=>({createMigrationApi:()=>api}))
vi.mock('@/host/localExecutor',()=>({requestLocalExecutor:(...args:unknown[])=>register(...args)}))
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
beforeEach(()=>{
 vi.clearAllMocks();api.projectReport.mockResolvedValue({jobId:'job',itemId:'item',pageIndex:0,fields:[{field:'source_root',ordinal:0,value:'D:\\foreign-never-open',sourceRootId:'original-root'}],totalFields:1,nextPage:null,unobserved:[]})
 api.projectTargets.mockResolvedValue({targetCatalogId:'catalog',pageIndex:0,items:[{targetHandle:'target-handle',displayName:'User native label',roots:1,currentWorkspace:true}],totalItems:1,nextPage:null,registeredWorkspacesObserved:true})
 api.projectTargetRoots.mockResolvedValue({targetCatalogId:'catalog',targetHandle:'target-handle',pageIndex:0,roots:[{targetRootHandle:'root-handle',path:'/target/user',ordinal:0,trusted:true,available:true}],totalRoots:1,nextPage:null})
})
it('requires an explicit native target and root mapping before returning a project choice',async()=>{
 const save=vi.fn();render(<MigrationProjectMapping deviceId="original-target" jobId="job" itemId="item" isCurrent={()=>true} onSave={save}/>)
 await screen.findByText('User native label');expect(screen.getByTestId('migration-project-map-save')).toBeDisabled()
 fireEvent.click(screen.getByTestId('migration-project-target'));await waitFor(()=>expect(api.projectTargetRoots).toHaveBeenCalled())
 fireEvent.change(screen.getByTestId('migration-project-root-map'),{target:{value:'root-handle'}})
 await waitFor(()=>expect(screen.getByTestId('migration-project-map-save')).not.toBeDisabled());fireEvent.click(screen.getByTestId('migration-project-map-save'))
 expect(save).toHaveBeenCalledWith({kind:'project',itemId:'item',mapping:{targetCatalogId:'catalog',targetHandle:'target-handle',mappings:[{sourceRootId:'original-root',targetRootHandle:'root-handle'}]}})
})
it('registers only the separately entered target directory with preserveExisting and never applies a late response after unmount',async()=>{
 let finish!:(v:unknown)=>void;register.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 const view=render(<MigrationProjectMapping deviceId="original-target" jobId="job" itemId="item" isCurrent={()=>true}/>)
 await screen.findByText('User native label');fireEvent.change(screen.getByTestId('migration-project-register-name'),{target:{value:'Explicit new workspace'}});fireEvent.change(screen.getByTestId('migration-project-register-path'),{target:{value:'/target/new'}})
 fireEvent.click(screen.getByTestId('migration-project-register'));expect(register).toHaveBeenCalledWith('runtime.projects.upsert_local',expect.objectContaining({deviceId:'original-target',preserveExisting:true,name:'Explicit new workspace',roots:['/target/new']}))
 expect(JSON.stringify(register.mock.calls)).not.toContain('foreign-never-open');const key=register.mock.calls[0][1].projectKey;view.unmount()
 await act(async()=>{finish({accepted:true,projectKey:key})});expect(api.projectTargets).toHaveBeenCalledTimes(1)
})
it('keeps a definite existing-workspace conflict distinct from an unknown registration receipt',async()=>{
 register.mockRejectedValue(new Error('workspace_project_already_registered'))
 render(<MigrationProjectMapping deviceId="original-target" jobId="job" itemId="item" isCurrent={()=>true}/>)
 await screen.findByText('User native label');fireEvent.change(screen.getByTestId('migration-project-register-name'),{target:{value:'Keep original'}});fireEvent.change(screen.getByTestId('migration-project-register-path'),{target:{value:'/target/user'}})
 fireEvent.click(screen.getByTestId('migration-project-register'));await screen.findByText('registrationConflict');expect(register).toHaveBeenCalledTimes(1)
 fireEvent.click(screen.getByTestId('migration-project-refresh'));await waitFor(()=>expect(api.projectTargets).toHaveBeenCalledTimes(2));expect(register).toHaveBeenCalledTimes(1)
})
