import test from 'node:test';
import assert from 'node:assert/strict';
import { createMigrationSourceOperationHttp } from './migration-source-operation-http.js';
const id='22222222-2222-4222-8222-222222222222';
function fixture() {
  const calls=[];
  return {calls, args:{pathname:'/api/migration/source-transfer/run',request:{method:'POST'},response:{},authSession:{}},
    options:{service:{run:async()=>{calls.push('run');return {requestId:id,coordinatorState:'running',observation:'unobserved',result:null,progress:null,errorCode:null};}},
    requireSameOriginMutation:()=>true,
    requestBody:async(_r,limit)=>{assert.equal(limit,65536);calls.push('body');return JSON.stringify({requestId:id,attemptId:id,source:{sessionId:id,purpose:'source',targetId:'source'},target:{sessionId:id,purpose:'target',targetId:'target'}});},
    jsonResponse:(_r,status,body)=>calls.push({status,body}),
    resolveSelection:({selection})=>({target:{id:selection.targetId},workspacePath:selection.workspacePath,captureCurrent:()=>({})})}};
}
test('operation HTTP gates run before body parsing and admission',async()=>{
  for(const variant of ['auth','method','origin']){
    const f=fixture();
    if(variant==='auth')f.args.authSession=null;
    if(variant==='method')f.args.request.method='GET';
    if(variant==='origin')f.options.requireSameOriginMutation=()=>false;
    assert.equal(await createMigrationSourceOperationHttp(f.options)(f.args),true);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].status,{auth:401,method:405,origin:403}[variant]);
  }
});
test('admission acknowledgement does not become a completed transfer',async()=>{
  const f=fixture();await createMigrationSourceOperationHttp(f.options)(f.args);
  assert.deepEqual(f.calls,['body','run',{status:200,body:{requestId:id,coordinatorState:'running',observation:'unobserved',result:null,progress:null,errorCode:null}}]);
});
test('unknown mutation outcomes are redacted and never retried',async()=>{
  const f=fixture();f.options.service.run=async()=>{f.calls.push('run');throw new Error('private filesystem and token');};
  await createMigrationSourceOperationHttp(f.options)(f.args);
  assert.deepEqual(f.calls,['body','run',{status:409,body:{error:'source_transfer_outcome_unknown'}}]);
});


test('malformed or cross-request service responses are never published as success',async()=>{
  for(const result of [{status:'completed'}, {requestId:'another',coordinatorState:'unknown',observation:'unobserved',result:null,progress:null,errorCode:null}]){
    const f=fixture();f.options.service.run=async()=>result;
    await createMigrationSourceOperationHttp(f.options)(f.args);
    assert.deepEqual(f.calls.at(-1),{status:409,body:{error:'source_transfer_invalid_response'}});
  }
});
test('all received and adoption HTTP operations retain authentication, method and origin gates', async () => {
  for (const operation of ['received', 'adoption-prepare', 'adoption-read', 'adoption-resume', 'adoption-cancel']) {
    for (const gate of ['auth', 'method', 'origin']) {
      const f = fixture(); f.args.pathname = '/api/migration/source-transfer/' + operation;
      if (gate === 'auth') f.args.authSession = null;
      if (gate === 'method') f.args.request.method = 'GET';
      if (gate === 'origin') f.options.requireSameOriginMutation = () => false;
      await createMigrationSourceOperationHttp(f.options)(f.args);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].status, { auth: 401, method: 405, origin: 403 }[gate]);
    }
  }
});
test('adoption HTTP returns explicit untracked state and never retries an uncertain prepare', async () => {
  const f = fixture(); f.args.pathname = '/api/migration/source-transfer/adoption-prepare';
  f.options.requestBody = async () => JSON.stringify({ locator: { requestId: id, adoptionId: id,
    target: { sessionId: id, purpose: 'target_recovery', targetId: 'target' } }, manifestSha256: 'a'.repeat(64), selections: [{ entryId: 'e0000-0000' }] });
  f.options.service.adoptionPrepare = async () => { f.calls.push('prepare'); return { state: null }; };
  await createMigrationSourceOperationHttp(f.options)(f.args);
  assert.deepEqual(f.calls, ['prepare', { status: 200, body: { state: null } }]);
  f.calls.length = 0;
  f.options.service.adoptionPrepare = async () => { f.calls.push('prepare'); throw new Error('private state path'); };
  await createMigrationSourceOperationHttp(f.options)(f.args);
  assert.deepEqual(f.calls, ['prepare', { status: 409, body: { error: 'source_transfer_outcome_unknown' } }]);
});
