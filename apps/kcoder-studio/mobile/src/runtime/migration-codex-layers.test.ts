import {expect,it,vi} from 'vitest';
import {MobileMigrationClient} from './migration-client';
const source={sourceId:'derived',kind:'codex',displayName:'snapshot',scope:'codex-project-layers',formatRevision:'codex-selected-layers/v1',availableCategories:['provider']};
const report={target:{kind:'job',jobId:'owned',itemId:'p'},status:'available',pageIndex:0,adapterRevision:'codex-selected-layers/v1',layers:[{index:0,kind:'user',present:true},{index:1,kind:'profile',present:true},{index:2,kind:'project',present:false}],fields:[{field:'/model',layer:1,providerIndex:null,supported:true,ignored:false,private:false}],totalFields:1,nextPage:null,unobserved:['command_line_overrides','source_process_environment','system_cloud_managed_defaults','managed_requirements','separate_mcp_namespaces','git_worktree_runtime_routing']};
it('keeps old capabilities inert, requires explicit consent and retains no mutation intent for a static selection',async()=>{
  const request=vi.fn(async()=>({source,replacesSourceIds:['original']})),put=vi.fn(),journal={read:async()=>[],put};
  const old=new MobileMigrationClient(request,{migrationConfigurationLayersV1:true},journal,()=>true);
  await expect(old.call('codexLayersSelect',{sourceId:'original',includeProject:true})).rejects.toMatchObject({code:'migration_update_required'});expect(request).not.toHaveBeenCalled();
  const client=new MobileMigrationClient(request,{migrationCodexLayersV1:true},journal,()=>true);
  await expect(client.call('codexLayersSelect',{sourceId:'original',includeProject:true})).resolves.toMatchObject({source});expect(put).not.toHaveBeenCalled();
  await expect(client.call('codexLayersSelect',{sourceId:'original',includeProject:false})).rejects.toMatchObject({code:'migration_codex_project_consent_required'});
  await expect(client.call('codexLayersSelect',{sourceId:'original',includeProject:true,root:'/private'} as never)).rejects.toMatchObject({code:'migration_invalid_parameters'});
});
it('rejects malformed/foreign/private origin reports and late account responses',async()=>{
  for(const value of [{...report,target:{kind:'job',jobId:'peer'}},{...report,fields:[{...report.fields[0],field:'PRIVATE_KEY_NAME'}]},{...report,fields:[{...report.fields[0],layer:2}]},{...report,layers:[report.layers[0],{index:2,kind:'project',present:true}]}]) {
    const client=new MobileMigrationClient(async()=>value,{migrationCodexLayersV1:true},{read:async()=>[],put:async()=>{}},()=>true);
    await expect(client.call('codexLayersRead',{target:{kind:'job',jobId:'owned',itemId:'p'}})).rejects.toMatchObject({code:'migration_invalid_response'});
  }
  let current=true,resolve!:(v:unknown)=>void;const client=new MobileMigrationClient(()=>new Promise(yes=>{resolve=yes}),{migrationCodexLayersV1:true},{read:async()=>[],put:async()=>{}},()=>current);
  const pending=client.call('codexLayersRead',{target:{kind:'job',jobId:'owned',itemId:'p'}});current=false;resolve(report);await expect(pending).rejects.toMatchObject({code:'migration_scope_changed'});
});
