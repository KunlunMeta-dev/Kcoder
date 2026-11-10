import { expect,it,vi } from 'vitest';
import examples from '../../../../shared/generated/examples.migration-projects.json';
import { MobileMigrationClient } from '../migration-client';
import { CALLS } from './contracts';
const journal=()=>({read:vi.fn(async()=>[]),put:vi.fn(async()=>{})});
it('gates project metadata and mapping independently before sending and never journals readonly inventory',async()=>{
  const value=examples.MigrationProjectSourcesResult[0].value,request=vi.fn(async()=>value),store=journal();
  const old=new MobileMigrationClient(request,{migrationBatchV1:true},store,()=>true);
  await expect(old.call('projectsDiscover',{source:'codex'})).rejects.toMatchObject({code:'migration_update_required'});expect(request).not.toHaveBeenCalled();
  const client=new MobileMigrationClient(request,{migrationProjectsV1:true},store,()=>true);
  await expect(client.call('projectsDiscover',{source:'codex'})).resolves.toEqual(value);expect(CALLS.projectsDiscover).toMatchObject({read:true,rows:['items']});expect(store.put).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({...value,source:'claude-code'});
  await expect(client.call('projectsDiscover',{source:'codex'})).rejects.toMatchObject({code:'migration_invalid_response'});
});
it('does not accept late project metadata after its account/target scope changed',async()=>{
  let current=true,finish!:(v:unknown)=>void;
  const client=new MobileMigrationClient(()=>new Promise(resolve=>{finish=resolve}),{migrationProjectsV1:true},journal(),()=>current);
  const pending=client.call('projectsDiscover',{source:'codex'});current=false;finish(examples.MigrationProjectSourcesResult[0].value);
  await expect(pending).rejects.toMatchObject({code:'migration_scope_changed'});
});
