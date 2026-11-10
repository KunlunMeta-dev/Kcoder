import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIntegrationAdmission, integrationCapability, INTEGRATION_CLIENT_CAPABILITIES, projectIntegrationCapabilities, projectTaskStateNotification } from '../src/integrations/core/admission.mjs';

const capabilities = { integrationScopeV1: true, memoryReviewV1: true };
const current = { ...capabilities, initialized: true };
const scope = { accountId: 'account', targetId: 'target', workspaceId: null,
  identityGeneration: 'generation', targetRevision: 'configuration' };
const read = { id: 1, method: 'integrations/memory/list', params: {
  contractVersion: 'parallel-v1', requestId: 'request', scope, timeoutMs: 1000, payload: {},
} };

test('task-state reads require their own native opt-in and cannot impersonate producer notifications', () => {
  const opted = { ...current, integrationTaskStateV1: true };
  const peer = { ...capabilities, integrationTaskStateV1: true };
  const request = { id: 31, method: 'integrations/runtime/readTaskState', params: {
    requestId: 'original-state', scope, reference: { threadId: 'original', turnId: 'turn' },
  } };
  assert.throws(() => assertIntegrationAdmission(request, current, peer, true), /CAPABILITY_UNAVAILABLE/);
  assert.doesNotThrow(() => assertIntegrationAdmission(request, opted, peer, true));
  assert.throws(() => assertIntegrationAdmission({ ...request, method: 'integrations/runtime/taskStateChanged' }, opted, peer, true), /NATIVE_ONLY/);
});

test('task-state metadata reaches only opted clients and rejects malformed or private fields', () => {
  const opted = { ...current, integrationTaskStateV1: true };
  const peer = { ...capabilities, integrationTaskStateV1: true };
  const notification = { method: 'integrations/runtime/taskStateChanged', params: {
    scope, operationId: 'original', entityId: 'original', sequence: 8, revision: 8,
    observedAtMs: 1234, snapshot: false, reference: { threadId: 'original', turnId: 'turn' }, state: 'completed',
  } };
  assert.equal(projectTaskStateNotification(notification, current, peer), null);
  assert.equal(projectTaskStateNotification(notification, opted, capabilities), null);
  assert.equal(projectTaskStateNotification(notification, opted, peer), notification);
  assert.equal(projectTaskStateNotification({ ...notification, params: { ...notification.params, output: 'private' } }, opted, peer), null);
});

test('browser account metadata requires its own opt-in and cannot grant browser execution', () => {
  const extended = { ...capabilities, browserProfilesV1: true };
  const message = { ...read, method: 'integrations/browserProfiles/list' };
  assert.equal(integrationCapability(message.method), 'browserProfilesV1');
  assert.throws(() => assertIntegrationAdmission(message, current, extended, true), /CAPABILITY_UNAVAILABLE/);
  assert.doesNotThrow(() => assertIntegrationAdmission(message, { ...extended, initialized: true }, extended, true));
  assert.throws(() => assertIntegrationAdmission(message, { ...extended, initialized: true }, capabilities, true), /CAPABILITY_UNAVAILABLE/);
  const { id: _id, ...notification } = message;
  assert.throws(() => assertIntegrationAdmission(notification, { ...extended, initialized: true }, extended, true), /REQUEST_INVALID/);
  assert.equal(integrationCapability('integrations/browserProfiles/execute'), null);
  assert.equal(integrationCapability('browser/start'), null);
});

test('profiled browser starts cannot borrow another client opt-in or inject a profile path', () => {
  const extended = { ...capabilities, browserProfileSessionsV1: true };
  const profile = { scope, profileId:'office', expectedRevision:1, operationId:'start-office' };
  const message = { id:1, method:'browser/start', params:{url:'http://example.test/',profile} };
  assert.throws(() => assertIntegrationAdmission(message, current, extended, true), /CAPABILITY_UNAVAILABLE/);
  assert.doesNotThrow(() => assertIntegrationAdmission(message, {...extended,initialized:true}, extended, true));
  assert.throws(() => assertIntegrationAdmission({...message,params:{...message.params,profile:{...profile,path:'/other/browser'}}},
    {...extended,initialized:true},extended,true), /REQUEST_INVALID/);
  assert.doesNotThrow(() => assertIntegrationAdmission({id:2,method:'browser/start',params:{url:'http://example.test/'}},current,capabilities,true));
});

test('handoff and human actions require the original client profile capability and typed control revision',()=>{
  const extended={...capabilities,browserProfileSessionsV1:true,initialized:true};
  const requests=[
    {id:1,method:'browser/profile/handoff',params:{sessionId:'session',expectedRevision:1,mode:'human'}},
    {id:2,method:'browser/profile/humanAction',params:{expectedRevision:2,action:{session_id:'session',action:'text',text:'owned synthetic input'}}},
    {id:3,method:'browser/profile/controlRead',params:{session_id:'session'}},
  ];
  for(const message of requests){
    assert.throws(()=>assertIntegrationAdmission(message,current,extended,true),/CAPABILITY_UNAVAILABLE/);
    assert.doesNotThrow(()=>assertIntegrationAdmission(message,extended,extended,true));
  }
  assert.throws(()=>assertIntegrationAdmission({...requests[1],params:{...requests[1].params,expectedRevision:'two'}},extended,extended,true),/REQUEST_INVALID/);
});

test('integration methods use the generated Rust registry and a separate scope contract', () => {
  assert.equal(integrationCapability('integrations/memory/forget'), 'memoryReviewV1');
  assert.equal(integrationCapability('integrations/scope/read'), 'integrationScopeV1');
  assert.equal(integrationCapability('integrations/memory/reset'), null);
  assert.doesNotThrow(() => assertIntegrationAdmission(read, current, capabilities, true));
  assert.doesNotThrow(() => assertIntegrationAdmission({ id: 2, method: 'integrations/scope/read', params: {} }, current, capabilities, true));
});

test('legacy, detached, pending and unsupported peers cannot borrow a native integration opt-in', () => {
  for (const client of [{ initialized: true }, { ...current, initialized: false }, { ...current, integrationScopeV1: false }]) {
    assert.throws(() => assertIntegrationAdmission(read, client, capabilities, true), /CAPABILITY_UNAVAILABLE/);
  }
  assert.throws(() => assertIntegrationAdmission(read, current, capabilities, false), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertIntegrationAdmission(read, current, { ...capabilities, memoryReviewV1: false }, true), /CAPABILITY_UNAVAILABLE/);
  assert.deepEqual(projectIntegrationCapabilities(capabilities, { initialized: true }), { integrationScopeV1: false, memoryReviewV1: false });
  assert.deepEqual(projectIntegrationCapabilities({}, current), {});
  assert.deepEqual(projectIntegrationCapabilities(capabilities, { initialized:true, memoryReviewV1:true }), { integrationScopeV1:false, memoryReviewV1:false });
});

test('caller-selected scope lookup, credential fields and id-less requests fail before forwarding', () => {
  const request = { id: 1, method: 'integrations/scope/read', params: { accountId: 'SYNTHETIC_PRIVATE_VALUE' } };
  assert.throws(() => assertIntegrationAdmission(request, current, capabilities, true), error =>
    error.code === -32602 && !error.message.includes('SYNTHETIC_PRIVATE_VALUE'));
  assert.throws(() => assertIntegrationAdmission({ ...read, params: { ...read.params, credential: 'synthetic' } }, current, capabilities, true), /REQUEST_INVALID/);
  const { id: _id, ...notification } = read;
  assert.throws(() => assertIntegrationAdmission(notification, current, capabilities, true), /REQUEST_INVALID/);
});

test('knowledge and automation controls require their own current-client opt-in', () => {
  const extended = { ...capabilities, knowledgePublicationsV1: true, automationTemplatesV1: true };
  for (const [method, capability] of [
    ['integrations/knowledge/readPublicationSources', 'knowledgePublicationsV1'],
    ['integrations/knowledge/publishKnowledge', 'knowledgePublicationsV1'],
    ['integrations/automation/listTemplates', 'automationTemplatesV1'],
    ['integrations/automation/saveSubscription', 'automationTemplatesV1'],
  ]) {
    const message = { ...read, method };
    assert.equal(integrationCapability(method), capability);
    assert.throws(() => assertIntegrationAdmission(message, current, extended, true), /CAPABILITY_UNAVAILABLE/);
    assert.doesNotThrow(() => assertIntegrationAdmission(message, { ...extended, initialized: true }, extended, true));
    assert.throws(() => assertIntegrationAdmission(message, { ...extended, initialized: true }, { ...extended, [capability]: false }, true), /CAPABILITY_UNAVAILABLE/);
  }
  const projected = projectIntegrationCapabilities(extended, current);
  assert.equal(projected.knowledgePublicationsV1, false);
  assert.equal(projected.automationTemplatesV1, false);
  for (const method of ['integrations/automation/triggerApprovedSubscription', 'integrations/automation/recordArtifactClaim', 'integrations/knowledge/evaluatePolicy']) {
    assert.equal(integrationCapability(method), null);
  }
});


test('retired channel service grants are absent from the integration client surface', () => {
  for (const method of ['capabilities', 'prepare', 'read', 'current', 'start', 'stop', 'renew', 'revoke'])
    assert.equal(integrationCapability(`integrations/services/channel/${method}`), null);
  assert.ok(!INTEGRATION_CLIENT_CAPABILITIES.some(name => name.startsWith('nativeChannelService')));
});
