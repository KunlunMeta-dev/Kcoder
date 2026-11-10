import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIntegrationAdmission, integrationCapability, projectIntegrationCapabilities } from '../src/integrations/core/admission.mjs';
const caps = { integrationScopeV1: true, remoteOperationControlV1: true };
const fields = { requestId: 'observe-original', scope: { accountId: 'a', targetId: 't', workspaceId: 'w', identityGeneration: 'g', targetRevision: 'r' }, operationId: 'original' };
test('remote control is explicit typed capability, never a delegate/raw request surface', () => {
  const read = { id: 1, method: 'integrations/remotes/readOperation', params: fields };
  assert.equal(integrationCapability(read.method), 'remoteOperationControlV1');
  assert.equal(integrationCapability('integrations/remotes/delegate'), null);
  const list={id:2,method:'integrations/remotes/listOperations',params:{requestId:'own-recent',scope:fields.scope}};
  assert.equal(integrationCapability(list.method),'remoteOperationControlV1');
  assert.doesNotThrow(()=>assertIntegrationAdmission(list,{...caps,initialized:true},caps,true));
  assert.throws(()=>assertIntegrationAdmission({...list,params:{...list.params,command:'runner'}},{...caps,initialized:true},caps,true),/REQUEST_INVALID/);
  assert.doesNotThrow(() => assertIntegrationAdmission(read, { ...caps, initialized: true }, caps, true));
  for (const client of [{ initialized: true }, { initialized: true, remoteOperationControlV1: true }])
    assert.throws(() => assertIntegrationAdmission(read, client, caps, true), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertIntegrationAdmission({ ...read, params: { ...fields, approved: true } }, { ...caps, initialized: true }, caps, true), /REQUEST_INVALID/);
  const noId = { method: read.method, params: fields };
  assert.throws(() => assertIntegrationAdmission(noId, { ...caps, initialized: true }, caps, true), /REQUEST_INVALID/);
  assert.equal(projectIntegrationCapabilities(caps, { initialized: true }).remoteOperationControlV1, false);
});
