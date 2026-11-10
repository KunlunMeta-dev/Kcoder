import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function originalBusinessToolResult(message){
 const content=typeof message.content==='string'?message.content:message.content.map(block=>block.text??'').join('');
 try{return JSON.parse(content);}catch{}
 // Engine errors may include a fixed prefix and guidance after the original
 // JSON receipt. Parse only a complete balanced object, then validate it below.
 const start=content.indexOf('{');if(start<0)return null;
 let depth=0,quoted=false,escaped=false;
 for(let index=start;index<content.length;index++){
  const char=content[index];
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){
   try{return JSON.parse(content.slice(start,index+1));}catch{return null;}
  }
 }
 return null;
}
export function createBusinessUnknownProtocol({hardDrop=false}={}){
 const observations=[],errors=[];let active;
 return {
  observations,errors,
  select(scenario,operationId){assert.equal(scenario.phase,'effect');active={...scenario,operationId,effectReady:false};},
  releaseEffect(operationId){assert.equal(active.operationId,operationId);active.effectReady=true;},
  respond({body,requestNumber}){
   try{
    assert.ok(active);assert.ok(requestNumber<=4,'One bounded original effect and one read-only lookup');
    const original=JSON.parse(body.messages.find(message=>message.role==='user').content);
    assert.equal(original.originalOperationId,active.operationId);assert.ok(original.task.includes(active.marker));
    const results=body.messages.filter(message=>message.role==='tool').map(originalBusinessToolResult),tools=(body.tools??[]).map(tool=>tool.function??tool);
    let raw,args;
    if(results.length===0){raw='document_create';args={resourceUri:original.selectedResourceUris[0],operationId:active.operationId,title:'Owned review',body:'Owned approved document: 37 units.'};}
    else if(results.length===1){
     if(!results[0]){
      const message=body.messages.filter(message=>message.role==='tool')[0],text=typeof message.content==='string'?message.content:JSON.stringify(message.content);
      observations.push({stage:'unparsed_original_tool_result',bytes:Buffer.byteLength(text),sha256:sha(text),hasObject:text.includes('{'),hasEscapedQuote:text.includes('\\"'),hasKnownBusinessCode:text.includes('APPLICATION_BUSINESS_'),hasToolFailure:text.includes('tool execution failed'),hasTimeout:text.toLowerCase().includes('timeout')});
     }
     assert.ok(results[0],'Original structured unknown receipt must be present before lookup');
     assert.equal(results[0].code,'APPLICATION_BUSINESS_ORIGINAL_MCP_RESULT_UNCONFIRMED');
     assert.equal(results[0].operationReceipt.phase,'unknown');
     observations.push({stage:'original_unknown',receipt:results[0].operationReceipt});
     raw='document_lookup';args={resourceUri:original.selectedResourceUris[0],operationId:active.operationId};
    }else{
     assert.equal(results.length,2);
     if(hardDrop){assert.ok(!results[1]?.reconciled);observations.push({stage:'original_still_unknown',replayed:false});}
     else{
      const lookup=results[1];assert.equal(lookup.reconciled,true);assert.equal(lookup.replayed,false);
      assert.equal(lookup.operationReceipt.operationId,results[0].operationReceipt.operationId);assert.equal(lookup.operationReceipt.phase,'completed');
      assert.equal(lookup.applicationLookup.state,'found');assert.equal(lookup.applicationLookup.object.operationId,active.operationId);
      assert.equal(lookup.applicationLookup.object.title,'Owned review');assert.equal(lookup.applicationLookup.object.body,'Owned approved document: 37 units.');
      observations.push({stage:'original_reconciled',receipt:lookup.operationReceipt,manifest:lookup.manifest,objectSha256:sha(JSON.stringify(lookup.applicationLookup.object))});
     }
     return [{delta:{role:'assistant',content:hardDrop?'OWNED_ORIGINAL_EFFECT_REMAINS_UNKNOWN':'OWNED_ORIGINAL_OBJECT_RECONCILED'}},{finishReason:'stop'}];
    }
    const matching=tools.filter(tool=>tool.name.endsWith('__'+raw));assert.equal(matching.length,1);
    observations.push({stage:'original_tool',requestNumber,tool:raw,operationId:active.operationId});
    return [...(results.length===0?[{ready:()=>active.effectReady}]:[]),{delta:{role:'assistant',tool_calls:[{index:0,id:`owned-unknown-${requestNumber}`,type:'function',function:{name:matching[0].name,arguments:JSON.stringify(args)}}]}},{finishReason:'tool_calls'}];
   }catch(error){errors.push({requestNumber,code:error.code??'UNKNOWN_PROTOCOL_UNCONFIRMED',message:String(error.message).slice(0,400)});return [{delta:{role:'assistant',content:'OWNED_UNKNOWN_PROTOCOL_UNCONFIRMED'}},{finishReason:'stop'}];}
  },
 };
}
