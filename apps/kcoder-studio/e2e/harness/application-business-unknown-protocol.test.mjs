import assert from 'node:assert/strict';
import test from 'node:test';
import {createBusinessUnknownProtocol,originalBusinessToolResult} from './application-business-unknown-protocol.mjs';
const operationId='owned-original',marker='OWNED_BUSINESS_tencent_docs_effect',uri='owned-application://document/original';
const body=results=>({messages:[{role:'user',content:JSON.stringify({originalOperationId:operationId,task:marker,selectedResourceUris:[uri]})},...results.map(content=>({role:'tool',content:typeof content==='string'?content:JSON.stringify(content)}))],tools:['document_create','document_lookup'].map(name=>({function:{name:'mcp__owned__'+name}}))});
const unknown={code:'APPLICATION_BUSINESS_ORIGINAL_MCP_RESULT_UNCONFIRMED',operationReceipt:{operationId:'actual-effect-operation',phase:'unknown'}};
test('original structured error survives Engine prefix and trailing guidance without accepting truncated JSON',()=>{
 const receipt={...unknown,detail:'literal } and escaped " { still inside a string'};
 expectOriginal('Tool execution failed: '+JSON.stringify(receipt)+'\nInspect the original operation before retrying.',receipt);
 expectOriginal('Tool execution failed: '+JSON.stringify(receipt).slice(0,-1),null);
 function expectOriginal(content,expected){assert.deepEqual(originalBusinessToolResult({content}),expected);}
});
test('controlled unknown protocol requests one original create then only the registered lookup',()=>{
 const protocol=createBusinessUnknownProtocol();protocol.select({phase:'effect',marker},operationId);
 const first=protocol.respond({body:body([]),requestNumber:1});assert.equal(first[0].ready(),false);protocol.releaseEffect(operationId);assert.equal(first[0].ready(),true);
 assert.equal(first[1].delta.tool_calls[0].function.name,'mcp__owned__document_create');
 const second=protocol.respond({body:body(['Tool `owned` execution failed: '+JSON.stringify(unknown)]),requestNumber:2});
 assert.equal(second[0].delta.tool_calls[0].function.name,'mcp__owned__document_lookup');
 const found={reconciled:true,replayed:false,operationReceipt:{operationId:'actual-effect-operation',phase:'completed'},applicationLookup:{state:'found',object:{operationId,title:'Owned review',body:'Owned approved document: 37 units.'}},manifest:{id:'actual-lookup'}};
 protocol.respond({body:body([unknown,found]),requestNumber:3});assert.deepEqual(protocol.errors,[]);
 assert.equal(protocol.observations.filter(item=>item.tool==='document_create').length,1);
});
test('controlled hard-drop protocol accepts no fabricated lookup result or second create',()=>{
 const protocol=createBusinessUnknownProtocol({hardDrop:true});protocol.select({phase:'effect',marker},operationId);
 protocol.respond({body:body([]),requestNumber:1});protocol.releaseEffect(operationId);
 protocol.respond({body:body([unknown]),requestNumber:2});
 const final=protocol.respond({body:body([unknown,'Original lookup transport unavailable']),requestNumber:3});
 assert.match(final[0].delta.content,/REMAINS_UNKNOWN/);assert.deepEqual(protocol.errors,[]);
 assert.equal(protocol.observations.filter(item=>item.tool==='document_create').length,1);
});
