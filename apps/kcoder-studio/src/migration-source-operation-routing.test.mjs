import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMigrationSourceOperation, validMigrationSourceOperationResult } from './migration-source-operation-routing.js';

const id='22222222-2222-4222-8222-222222222222';
const source={sessionId:id,purpose:'source',targetId:'source'};
const target={sessionId:id,purpose:'target',targetId:'target'};
const recovery={...target,purpose:'target_recovery'};
const control={sequence:1,cancelWatermark:1,cancelled:true,ready:false};
function fixture() {
  const calls=[];
  const service=Object.fromEntries(['run','read','cancel','targetRead','targetCancel','targetResume','targetFinish','received','adoptionPrepare','adoptionRead','adoptionResume','adoptionCancel'].map(method=>[method,async args=>{calls.push([method,args]);return {coordinatorState:'unknown'};}]));
  return {calls,service,resolveSelection:async selector=>({target:{id:selector.targetId},workspacePath:selector.workspacePath,captureCurrent:()=>({ownerId:'real-gateway-owner'})})};
}
test('all public actions map only typed fields to resolved sessions',async()=>{
  for(const [operation,method,payload] of [
    ['run','run',{requestId:id,attemptId:id,source,target,selections:[{kind:'configuration',sourceId:'original'}]}],
    ['read','read',{requestId:id,source,target}],
    ['cancel','cancel',{requestId:id,commandId:id,source,target}],
    ['target-read','targetRead',{requestId:id,target:recovery}],
    ['target-cancel','targetCancel',{requestId:id,commandId:id,target:recovery}],
    ['target-finish','targetFinish',{requestId:id,attemptId:id,target:recovery}],
    ['target-resume','targetResume',{requestId:id,attemptId:id,target:recovery,expectedAdmissionControl:control,expectedOperationControl:null}],
  ]) {
    const f=fixture();
    assert.deepEqual(await routeMigrationSourceOperation(operation,payload,f),{coordinatorState:'unknown'});
    assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],method);
    const value=f.calls[0][1];assert.equal(value.requestId,id);
    assert.equal(typeof value.target.captureCurrent,'function');
    assert.equal(value.target.target.id,'target');
    assert.equal(value.target.purpose,operation.startsWith('target-')?'target-recovery':'target');
    if(operation==='target-resume') assert.equal(value.expectedOperationControl,null);
  }
});
test('role substitution cannot turn recovery into a full source transfer',async()=>{
  for(const [operation,payload] of [
    ['read',{requestId:id,source:target,target}],
    ['read',{requestId:id,source,target:recovery}],
    ['target-read',{requestId:id,target}],
  ]) {
    const f=fixture();await assert.rejects(routeMigrationSourceOperation(operation,payload,f));assert.equal(f.calls.length,0);
  }
});
test('authority fields and missing control confirmations are rejected before resolution',async()=>{
  for(const payload of [
    {requestId:id,attemptId:id,target:recovery,expectedAdmissionControl:control},
    {requestId:id,attemptId:id,target:recovery,expectedAdmissionControl:control,expectedOperationControl:null,peerRef:'forged'},
    {requestId:id,attemptId:id,target:recovery,expectedAdmissionControl:{...control,sequence:Number.MAX_SAFE_INTEGER+1},expectedOperationControl:null},
  ]) {
    const f=fixture();f.resolveSelection=()=>assert.fail('must not resolve invalid payload');
    await assert.rejects(routeMigrationSourceOperation('target-resume',payload,f));assert.equal(f.calls.length,0);
  }
});
test('failed second-endpoint authorization cannot start the transfer',async()=>{
  const f=fixture(), original=f.resolveSelection;
  f.resolveSelection=selector=>selector.targetId==='target'?Promise.reject(new Error('denied')):original(selector);
  await assert.rejects(routeMigrationSourceOperation('read',{requestId:id,source,target},f),/denied/);
  assert.equal(f.calls.length,0);
});
test('unknown outcome is returned without retrying a mutation',async()=>{
  const f=fixture();f.service.run=async()=>{f.calls.push('run');throw new Error('lost response');};
  await assert.rejects(routeMigrationSourceOperation('run',{requestId:id,attemptId:id,source,target,selections:[{kind:'configuration',sourceId:'original'}]},f),/lost response/);
  assert.deepEqual(f.calls,['run']);
});

test('nullable optional selections and resume retain Rust omission semantics',async()=>{
  const f=fixture();
  await routeMigrationSourceOperation('run',{requestId:id,attemptId:id,source,target,selections:null,resume:null},f);
  assert.equal(Object.hasOwn(f.calls[0][1],'selections'),false);
  assert.equal(Object.hasOwn(f.calls[0][1],'resume'),false);
});

const publicExamples = JSON.parse(readFileSync(new URL('../shared/generated/examples.migration-source.json', import.meta.url), 'utf8'));
test('received and adoption routes resolve only the target and keep explicit selection and control fields', async () => {
  const locator = { target: recovery, requestId: id, adoptionId: id };
  const expectedControl = { sequence: 3, cancelWatermark: 1 };
  const selections = [{ entryId: 'e0000-0000', projectMapping: 'current_workspace' }];
  for (const [operation, method, payload] of [
    ['received', 'received', { target: recovery, requestId: id, manifestSha256: 'a'.repeat(64), pageIndex: 0 }],
    ['adoption-prepare', 'adoptionPrepare', { locator, manifestSha256: 'a'.repeat(64), selections }],
    ['adoption-read', 'adoptionRead', locator],
    ['adoption-resume', 'adoptionResume', { locator, expectedControl }],
    ['adoption-cancel', 'adoptionCancel', { locator, commandId: id }],
  ]) {
    const f = fixture(), resolved = [], resolve = f.resolveSelection;
    f.resolveSelection = async value => { resolved.push(value); return resolve(value); };
    await routeMigrationSourceOperation(operation, payload, f);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].targetId, 'target');
    assert.equal(f.calls[0][0], method);
    const args = f.calls[0][1];
    assert.equal(Object.hasOwn(args, 'source'), false);
    assert.equal(args.requestId, id);
    if (operation.startsWith('adoption-')) assert.equal(args.adoptionId, id);
    if (operation === 'adoption-prepare') assert.deepEqual(args.selections, selections);
    if (operation === 'adoption-resume') assert.deepEqual(args.expectedControl, expectedControl);
    if (operation === 'adoption-cancel') assert.equal(args.commandId, id);
  }
});
test('received/adoption response identity checks do not turn another receipt into this result', () => {
  const received = structuredClone(publicExamples.MigrationSourceReceivedResult[0].value);
  const request = { target: recovery, requestId: received.receipt.requestId, manifestSha256: received.receipt.manifestSha256, pageIndex: 0 };
  assert.equal(validMigrationSourceOperationResult('received', request, received), true);
  assert.equal(validMigrationSourceOperationResult('received', { ...request, manifestSha256: 'b'.repeat(64) }, received), false);
  const result = structuredClone(publicExamples.MigrationSourceAdoptionResult.find(row => row.name === 'only_preview_ready').value);
  const locator = { target: recovery, requestId: result.state.requestId, adoptionId: result.state.adoptionId };
  assert.equal(validMigrationSourceOperationResult('adoption-read', locator, result), true);
  assert.equal(validMigrationSourceOperationResult('adoption-read', { ...locator, adoptionId: id }, result), false);
  assert.equal(validMigrationSourceOperationResult('adoption-read', locator, { state: null }), true);
});
test('adoption rejects source roles and caller-selected paths before resolving anything', async () => {
  for (const payload of [
    { locator: { requestId: id, adoptionId: id, target: source }, manifestSha256: 'a'.repeat(64), selections: [{ entryId: 'e0000-0000' }] },
    { locator: { requestId: id, adoptionId: id, target: recovery }, manifestSha256: 'a'.repeat(64), selections: [{ entryId: 'e0000-0000', projectMapping: '/arbitrary' }] },
  ]) {
    const f = fixture(); f.resolveSelection = () => assert.fail('must reject before resolution');
    await assert.rejects(routeMigrationSourceOperation('adoption-prepare', payload, f));
    assert.equal(f.calls.length, 0);
  }
});
