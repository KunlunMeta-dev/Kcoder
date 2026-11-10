import assert from 'node:assert/strict';
import {startApprovalModelFixture} from './approval-model.mjs';
import {openRpc,closeRpcAndWait,gatewayRpcUrl,isTurnCompletion} from './rpc.mjs';
import {login} from './http.mjs';
import {waitForGatewayRpcToken} from './gateway.mjs';
export const PHYSICAL_FETCH_URL='https://docs.python.org/3/library/asyncio.html';
export function physicalSharedCapabilities(){return{experimental:{interactionBindingV1:true,studioWorkModesV1:true}}}
const ids=['ssh-owner','ssh-peer','http-owner','http-peer'];
export async function startPhysicalWebModel(context,{executeWeb=false}={}){
 const states=Object.fromEntries(ids.map(id=>[id,{requests:0,release:false,toolResults:0}]));
 const fixture=await startApprovalModelFixture(context,{modelList:{ids},responseSteps:({body})=>{
  assert.ok(ids.includes(body.model),'Only owned model identities are accepted');
  const state=states[body.model];state.requests++;assert.ok(state.requests<=2,'No replay or extra model turn');
  const results=(body.messages||[]).filter(message=>message.role==='tool').length;
  if(!body.model.endsWith('owner')||!executeWeb)return[{delta:{role:'assistant',content:'OWNED_ACK_'+body.model},finishReason:'stop'}];
  if(!results)return[{delta:{role:'assistant',tool_calls:[{index:0,id:'physical-'+body.model+'-fetch',type:'function',function:{name:'WebFetch',arguments:JSON.stringify({url:PHYSICAL_FETCH_URL,prompt:'Read the actual official asyncio documentation.'})}}]},finishReason:'tool_calls'}];
  state.toolResults=results;assert.equal(results,1);
  return[{ready:()=>state.release,delta:{role:'assistant',content:'OWNED_FETCH_ACK_'+body.model},finishReason:'stop'}];
 }});
 return{...fixture,release(id){assert.ok(ids.includes(id));states[id].release=true},stats:()=>Object.fromEntries(ids.map(id=>[id,{requests:states[id].requests,toolResults:states[id].toolResults}]))};
}
function nativeSources(value){
 if(!value||typeof value!=='object')return[];
 const out=[];const walk=(value,depth)=>{if(!value||typeof value!=='object'||depth>16)return;if(value.schemaVersion===1&&value.operation==='fetch'&&value.toolCallId&&value.identity&&Array.isArray(value.sources))out.push(value);for(const [key,child]of Object.entries(value))if(key!=='content'&&key!=='output'){if(Array.isArray(child))for(const element of child)walk(element,depth+1);else walk(child,depth+1)}};walk(value,0);return out;
}
export async function exercisePhysicalWebTarget(context,{gateway,model,transport,remoteRoot,executeWeb}){
 const cookie=gateway.bootstrapCookie||await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 const connections=[];let owner,peer,reader,ownerThread,peerThread;
 const connect=async server=>{const rpc=await openRpc(gatewayRpcUrl(gateway,server,token),{headers:{Cookie:cookie,Origin:gateway.baseUrl},timeoutMs:30000});connections.push({server,rpc});context.addCleanup('close '+transport+' '+server+' RPC',()=>closeRpcAndWait(rpc));const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'owned-physical-'+transport+'-'+server,version:'1'},capabilities:physicalSharedCapabilities()});assert.ok(initialized.cwd?.startsWith(remoteRoot),'Actual remote Windows workspace is required');await context.writeArtifactJson('physical-'+transport+'-'+server+'-initialize-'+connections.length+'.json',{cwd:initialized.cwd,model:initialized.model,serverInfo:initialized.serverInfo});assert.equal(initialized.model,'owned::'+transport+'-'+server,'Controlled qualified model identity required before any turn');return rpc;};
 try {
 owner=await connect('owner');peer=await connect('peer');
 ownerThread=(await owner.request('thread/start',{})).thread;
 peerThread=(await peer.request('thread/start',{})).thread;
 assert.notEqual(ownerThread.id,peerThread.id);
 const peerTurn=async()=>{const {turn}=await peer.request('turn/start',{threadId:peerThread.id,input:[{type:'text',text:'Owned peer profile echo; do not use tools.'}]});const terminal=await peer.waitFor(frame=>isTurnCompletion(frame,peerThread.id,turn.id),30000,'physical peer terminal');await context.writeArtifactJson('physical-'+transport+'-peer-terminal-'+model.stats()[transport+'-peer'].requests+'.json',{params:terminal.params,modelStats:model.stats()});assert.equal(terminal.params.turn.status,'completed');return terminal;};
 await peerTurn();
 const {turn}=await owner.request('turn/start',{threadId:ownerThread.id,input:[{type:'text',text:executeWeb?'Use WebFetch exactly once to read the fixed official asyncio HTTPS page.':'Owned physical profile preflight echo; do not use tools.'}]});
 if(!executeWeb){const terminal=await owner.waitFor(frame=>isTurnCompletion(frame,ownerThread.id,turn.id),30000,'zero-public physical owner terminal');assert.equal(terminal.params.turn.status,'completed');await closeRpcAndWait(owner);await peerTurn();reader=await connect('owner');const snapshot=await reader.request('thread/read',{threadId:ownerThread.id,limit:100});assert.ok(JSON.stringify(snapshot).includes('OWNED_ACK_'+transport+'-owner'));assert.equal(model.stats()[transport+'-owner'].requests,1);assert.equal(model.stats()[transport+'-peer'].requests,2);assert.ok(connections.every(value=>!value.rpc.messages().some(frame=>frame.method==='item/started'&&frame.params?.item?.type==='toolCall')));await assert.rejects(peer.request('thread/read',{threadId:ownerThread.id,limit:20},10000));return{passed:true,transport,scope:'actual cross-host Gateway transport and independent profile echo only',publicFetches:0,paidModels:0,ownerThreadId:ownerThread.id,peerThreadId:peerThread.id};}
 const callId='physical-'+transport+'-owner-fetch';
 const approval=await owner.waitFor(frame=>frame.method==='approval/request'&&frame.params?.threadId===ownerThread.id&&frame.params?.turnId===turn.id,30000,'actual remote WebFetch ASK');
 const started=await owner.waitFor(frame=>frame.method==='item/started'&&frame.params?.threadId===ownerThread.id&&frame.params?.turnId===turn.id&&frame.params?.item?.type==='toolCall'&&frame.params.item.id===callId,10000,'actual remote native call identity');
 assert.equal(started.params.item.name,'WebFetch');
 assert.deepEqual(started.params.item.input,approval.params.action.input);
 if(approval.params.toolCallId!==undefined)assert.equal(approval.params.toolCallId,callId);assert.equal(approval.params.action.type,'tool');assert.equal(approval.params.action.name,'WebFetch');assert.deepEqual(approval.params.action.input,{url:PHYSICAL_FETCH_URL,prompt:'Read the actual official asyncio documentation.'});
 owner.respond(approval.id,{decision:'accept',approvalId:approval.params.approvalId,threadId:ownerThread.id,turnId:turn.id});
 const resolved=await owner.waitFor(frame=>frame.method==='approval/resolved'&&frame.params?.requestId===approval.id&&frame.params?.decision==='accept',10000,'remote approval resolved');
 const item=await owner.waitFor(frame=>frame.method==='item/completed'&&frame.params?.threadId===ownerThread.id&&frame.params?.item?.webSources?.toolCallId===callId,140000,'authoritative remote Fetch receipt');
 const receipt=item.params.item.webSources;assert.equal(receipt.operation,'fetch');assert.ok(['success','partial'].includes(receipt.status));assert.equal(receipt.sources[0].url,PHYSICAL_FETCH_URL);assert.ok(['read','partial'].includes(receipt.sources[0].readStatus));
 await closeRpcAndWait(owner);
 await peerTurn();
 reader=await connect('owner');
 const snapshot=await reader.request('thread/read',{threadId:ownerThread.id,limit:100},30000);
 const restored=nativeSources(snapshot).find(value=>value.toolCallId===callId);assert.ok(restored,'Read original authoritative receipt, never replay Fetch');assert.deepEqual(restored,receipt);
 await assert.rejects(peer.request('thread/read',{threadId:ownerThread.id,limit:20},10000));await assert.rejects(reader.request('thread/read',{threadId:peerThread.id,limit:20},10000));
 model.release(transport+'-owner');
 const later=await reader.request('thread/read',{threadId:ownerThread.id,limit:100});assert.equal(nativeSources(later).filter(value=>value.toolCallId===callId).length,1);
 const result={passed:true,transport,scope:'actual physical Windows target Fetch, client disconnect, original native receipt recovery and peer profile isolation',publicFetches:1,publicSearches:0,paidModels:0,ownerThreadId:ownerThread.id,peerThreadId:peerThread.id,turnId:turn.id,approval:{nativeItemStartedId:started.params.item.id,nativeItemStartedThreadId:started.params.threadId,nativeItemStartedTurnId:started.params.turnId,requestId:approval.id,approvalId:approval.params.approvalId,toolCallIdentityNegotiated:approval.params.toolCallId!==undefined,resolved:resolved.params.decision},receipt,restoredReceipt:restored,clientDisconnectedBeforeModelAck:true,fetchReplayed:false,peerContinued:true};
 await context.writeArtifactJson('physical-'+transport+'-web-receipt.json',result);return result;
 } finally {
  const snapshots=[];
  for(const [name,thread,rpc]of [['owner',ownerThread,reader||owner],['peer',peerThread,peer]]){
   if(!thread)continue;
   try{let connection=rpc;if(connection?.socket?.readyState!==1)connection=await connect(name);snapshots.push({profile:name,threadId:thread.id,value:await connection.request('thread/read',{threadId:thread.id,limit:100},10000)});}catch(error){snapshots.push({profile:name,threadId:thread.id,unavailable:true,errorType:error.name})}
  }
  await context.writeArtifactJson('physical-'+transport+'-all-native-frames.json',{connections:connections.map(({server,rpc})=>({profile:server,frames:rpc.messages()})),snapshots,modelCounts:model.stats(),publicFetchReplay:false});
 }
}
