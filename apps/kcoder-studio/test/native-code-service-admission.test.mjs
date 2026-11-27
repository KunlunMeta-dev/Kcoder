import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIntegrationAdmission, projectIntegrationCapabilities } from '../src/integrations/core/admission.mjs';
import { integrationControlCapability } from '../shared/integrationControlMethods.mjs';

const scope={accountId:'fixture-owner',targetId:'fixture-target',workspaceId:'fixture-workspace',identityGeneration:'1',targetRevision:'1'};
const request=(method,payload,mutation=false)=>({jsonrpc:'2.0',id:'same-request',method,params:{contractVersion:'parallel-v1',requestId:'same-request',scope,timeoutMs:60000,payload,
  ...(mutation?{operationId:'original-operation',expectedRevision:'1'}:{})}});
const client={initialized:true,integrationScopeV1:true,nativeCodeServicesV1:true};
const caps={integrationScopeV1:true,nativeCodeServicesV1:true};
test('native code service controls require each actual client opt-in and a finite typed method',()=>{
  const read=request('integrations/services/code/read',{leaseId:'original-lease'});
  assert.equal(integrationControlCapability(read.method),'nativeCodeServicesV1');
  assert.doesNotThrow(()=>assertIntegrationAdmission(read,client,caps,true));
  for(const changed of [{...client,nativeCodeServicesV1:false},{...client,integrationScopeV1:false},{...client,initialized:false}])
    assert.throws(()=>assertIntegrationAdmission(read,changed,caps,true));
  assert.throws(()=>assertIntegrationAdmission(read,client,caps,false));
  assert.equal(projectIntegrationCapabilities(caps,{...client,nativeCodeServicesV1:false}).nativeCodeServicesV1,false);
  assert.equal(integrationControlCapability('kcoder/nativeCodeService/startV1'),null);
});
test('code service payloads cannot add authority or omit explicit original mutation identities',()=>{
  const payload={purpose:'native_saved_code_service',explicitBackgroundConsent:true,expiresInMs:60000,codeWorkflow:{definitionId:'saved-code',version:1,args:{value:6}}};
  assert.doesNotThrow(()=>assertIntegrationAdmission(request('integrations/services/code/prepare',payload,true),client,caps,true));
  for(const body of [{...payload,trusted:true},{...payload,explicitBackgroundConsent:false},{...payload,expiresInMs:86400001}])
    assert.throws(()=>assertIntegrationAdmission(request('integrations/services/code/prepare',body,true),client,caps,true));
  assert.throws(()=>assertIntegrationAdmission(request('integrations/services/code/start',{leaseId:'original-lease'}),client,caps,true));
});
