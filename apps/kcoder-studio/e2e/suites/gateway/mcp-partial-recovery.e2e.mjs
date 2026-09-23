import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'mcp-partial-startup-recovery-and-complete-cache', tier: 'full-integration',
  modelPolicy: 'model-independent actual stdio MCP subprocesses and deterministic tool selection',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'partial-mcp' });
  const ready = context.pathInState('recoverable-ready');
  const starts = context.pathInState('starts.jsonl');
  const calls = context.pathInState('calls.jsonl');
  await writeFile(starts, ''); await writeFile(calls, '');
  const script = context.pathInState('partial-mcp.cjs');
  await writeFile(script, `const fs = require('node:fs');
const [name, ready, starts, calls] = process.argv.slice(2);
fs.appendFileSync(starts, name+'\\n');
if(name==='recoverable' && !fs.existsSync(ready)) { process.stderr.write('RECOVERABLE_FIXTURE_UNAVAILABLE\\n'); process.exit(1); }
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); if(m.id===undefined)return;
let result={};
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name,version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'partial_probe',description:'Owned partial recovery probe',inputSchema:{type:'object'}}]};
if(m.method==='tools/call'){fs.appendFileSync(calls,name+'\\n');result={content:[{type:'text',text:name+'_CALLED'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const latest = body.messages.findLastIndex(m => m.role === 'user');
    if (body.messages.slice(latest+1).some(m => m.role === 'tool')) return [{ delta: { role: 'assistant', content: 'PARTIAL_COMPLETE' }, finishReason: 'stop' }];
    const tools = body.tools.filter(t => t.function.name.endsWith('partial_probe'));
    assert.ok(tools.length > 0, 'healthy service remains usable');
    return [{ delta: { role: 'assistant', tool_calls: tools.map((t,index)=>({index,id:`partial-${index}`,type:'function',function:{name:t.function.name,arguments:'{}'}})) }, finishReason:'tool_calls' }];
  } });
  await context.writeStateJson('config/settings.json', { active_provider:'fixture', permission_mode:'yolo', max_retries:0,
    providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}},
    mcp_servers:['recoverable','healthy'].map(name=>({name,transport:'stdio',command:process.execPath,args:[script,name,ready,starts,calls]})) });
  await context.writeStateJson('config/credentials.json', {});
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace,kcoderBin:binary,env:{KCODER_CONFIG_DIR:context.pathInState('config')} });
  const token=await waitForGatewayRpcToken(context,gateway);
  const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token));
  context.addCleanup('close partial recovery RPC',()=>rpc.close());
  await initializeRpc(rpc,'partial-recovery');
  const run = async () => {
    const {thread}=await rpc.request('thread/start',{});
    const seen=new Set(rpc.messages());
    const {turn}=await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'PARTIAL_PROBE'}]});
    const done=await rpc.waitFor(m=>!seen.has(m)&&m.method==='turn/completed'&&m.params?.turnId===turn.id,45000,'partial probe completion');
    assert.equal(done.params.turn.status,'completed');
    return thread.id;
  };
  const first=await run();
  let listed = await rpc.request('mcp/list');
  assert.equal(listed.servers.find(s=>s.name==='recoverable').lastConnectionAttempt,'unavailable');
  assert.equal(listed.servers.find(s=>s.name==='healthy').lastConnectionAttempt,'ready');
  assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n'),['healthy']);
  const before=(await readFile(starts,'utf8')).trim().split('\n');
  assert.ok(before.filter(n=>n==='recoverable').length<=3,'failure must not cause uncontrolled reconnects');
  await writeFile(ready,'ready');
  const second=await run();
  listed = await rpc.request('mcp/list');
  assert.ok(listed.servers.every(s=>s.lastConnectionAttempt==='ready'));
  const recovered=(await readFile(starts,'utf8')).trim().split('\n');
  assert.equal(recovered.length,before.length+2,'next session retries the partial snapshot once');
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,3);
  const third=await run();
  assert.deepEqual((await readFile(starts,'utf8')).trim().split('\n'),recovered,'complete snapshot reuses connections');
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,5);
  for(const threadId of [first,second,third])await rpc.request('thread/delete',{threadId});
  return { startupAttempts:before.length,recoveredAttempts:recovered.length,healthyUnaffected:true,completeCacheReused:true };
});
