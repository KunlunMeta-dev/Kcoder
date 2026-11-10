import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeSearchSettings,nativeApprovalResponse,validateNativeSearchReceipt,NATIVE_BUNDLED_SEARCH_CALL,NATIVE_FIRST_SEARCH_QUERY} from './windows-native-web-search.mjs';
import {validateBundledParentSearchResult,validateInstalledNativeSearchMode} from './windows-installer-lifecycle.mjs';

test('the bundled query owns a separate explicit source ceiling without changing default search settings',()=>{
 assert.equal(Object.hasOwn(nativeSearchSettings('http://127.0.0.1:1/v1'),'web'),false);
 const settings=nativeSearchSettings('http://127.0.0.1:1/v1','bundled-parent-route');
 assert.deepEqual(settings.web,{search:{mode:'pinned',preferredProvider:'searxng-bundled',fallbackScope:'none',providers:[{id:'searxng-bundled',kind:'searxng',enabled:true}]}});
 assert.equal(Object.hasOwn(settings,'mcp_servers'),false);
 assert.equal(Object.hasOwn(settings,'permission_mode'),false);
 assert.throws(()=>nativeSearchSettings('http://127.0.0.1:1/v1','arbitrary'));
});
test('bundled ASK accepts only its distinct call identity and cannot authorize a fetch',()=>{
 const request={method:'approval/request',params:{threadId:'thread',turnId:'turn',approvalId:'approval',appServerEpoch:'epoch',toolCallId:NATIVE_BUNDLED_SEARCH_CALL,action:{type:'tool',name:'WebSearch',input:{query:NATIVE_FIRST_SEARCH_QUERY,num_results:3}}}};
 assert.equal(nativeApprovalResponse(request,'thread','turn','bundled-parent-route').decision,'accept');
 assert.throws(()=>nativeApprovalResponse(request,'thread','turn'));
 const wrong=structuredClone(request);wrong.params.action.name='WebFetch';
 assert.throws(()=>nativeApprovalResponse(wrong,'thread','turn','bundled-parent-route'));
});
const identity={build_commit:'a'.repeat(40),build_dirty:false,executable_sha256:'b'.repeat(64)};
const packet=()=>({schemaVersion:1,identity:{threadId:'thread'},toolCallId:NATIVE_BUNDLED_SEARCH_CALL,operation:'search',provider:'searxng-bundled',status:'partial',sources:[{url:'https://docs.python.org/3/library/asyncio.html',readStatus:'summary_only'}]});
const expected={expectedCommit:identity.build_commit,expectedCliSha256:identity.executable_sha256};
const result=()=>({steps:[{action:'nativeWebSearch',sid:'ordinary'},{action:'nativeBundledSearch',sid:'ordinary',isAdmin:false}],bundledParentRoute:{passed:true,scope:'actual-native-bundled-source-under-system-automatic-proxy',searchConfigurationWritten:true,mcpConfigurationWritten:false,externalModelCalls:0,controlledProviderRequests:2,permissionMode:'ask',receipt:packet(),approvals:[{toolCallId:NATIVE_BUNDLED_SEARCH_CALL,decision:'accept',resolved:true}],ordinaryAccountNetwork:{apiSucceeded:true,autoDetect:true,pacUrlConfigured:false,proxyEnvironmentPresent:false},nativeEof:{forcedKill:false,exitCode:0},nativeOwnedWorkersAbsent:true,parentRouteEvidence:{requiredByObservedSystemFlags:true,perUrlCounterObserved:false},buildIdentity:identity}});
test('a nonempty native Searx receipt cannot be replaced with Exa or a default call',()=>{
 validateNativeSearchReceipt(packet(),'thread','bundled-parent-route');
 for(const patch of [{provider:'exa-public'},{toolCallId:'owned-native-first-web-search'},{sources:[]}])assert.throws(()=>validateNativeSearchReceipt({...packet(),...patch},'thread','bundled-parent-route'));
});
test('the bundled proof requires actual automatic flags, normal ASK, same SID and clean EOF',()=>{
 validateBundledParentSearchResult(result(),expected);
 for(const change of [v=>{v.steps[1].sid='other'},v=>{v.bundledParentRoute.ordinaryAccountNetwork.autoDetect=false},v=>{v.bundledParentRoute.ordinaryAccountNetwork.proxyEnvironmentPresent=true},v=>{v.bundledParentRoute.nativeEof.forcedKill=true},v=>{v.bundledParentRoute.nativeOwnedWorkersAbsent=false},v=>{v.bundledParentRoute.approvals=[]},v=>{v.bundledParentRoute.receipt.provider='bing-html'},v=>{v.bundledParentRoute.controlledProviderRequests=3}]){const value=result();change(value);assert.throws(()=>validateBundledParentSearchResult(value,expected));}
});
test('an appended bundled query cannot silently join a different installer lane',()=>{
 assert.throws(()=>validateInstalledNativeSearchMode({nativeBundledParentRoute:true}));
 assert.throws(()=>validateInstalledNativeSearchMode({nativeBundledParentRoute:true,nativeWebSearch:true,nativeWebFreshOnly:false}));
});
