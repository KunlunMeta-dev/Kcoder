import { expect,it,vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-projects.json'
import { createTestGatewayRuntime,FakeGatewayClient } from './gatewayRuntime.test-support'
const target={id:'remote',label:'Remote',runtime:'kcoder' as const,description:'',transport:'ssh' as const,host:'owned.invalid',workspacePath:'/owned'}
it('negotiates projects before reads, initial scans and explicit mapping plans, binding the exact reply and read lane',async()=>{
 const client=new FakeGatewayClient(null),cap=vi.spyOn(client,'supportsExperimental').mockImplementation(name=>name!=='migrationProjectsV1')
 const request=vi.spyOn(client,'request').mockResolvedValue(examples.MigrationProjectSourcesResult[0].value as never)
 const runtime=createTestGatewayRuntime('token',{loadServers:async()=>[target],createClient:()=>client}), options={signal:new AbortController().signal}
 const invoke=(method:string,params:unknown)=>runtime.request('runtime.migration.request',{deviceId:target.id,method,params},options)
 try{
  await expect(invoke('migration/projects/discover',{source:'codex'})).rejects.toThrow('migration_projects_update_required')
  await expect(invoke('migration/batch/scan',{sourceIds:[],projectSources:[{catalogId:'c',sourceHandle:'h'}]})).rejects.toThrow('migration_projects_update_required')
  expect(request).not.toHaveBeenCalled();cap.mockReturnValue(true)
  await expect(invoke('migration/projects/discover',{source:'codex',path:'/ungranted'})).rejects.toThrow('migration_invalid_parameters')
  await expect(invoke('migration/projects/discover',{source:'codex'})).resolves.toHaveProperty('catalogId')
  expect(request).toHaveBeenLastCalledWith('migration/projects/discover',{source:'codex'},options)
  request.mockResolvedValueOnce({...examples.MigrationProjectSourcesResult[0].value,source:'claude-code'} as never)
  await expect(invoke('migration/projects/discover',{source:'codex'})).rejects.toThrow('migration_invalid_response')
 }finally{await runtime.dispose()}
})
