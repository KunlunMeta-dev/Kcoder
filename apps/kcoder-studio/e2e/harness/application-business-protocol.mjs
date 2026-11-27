import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {createBusinessFixture}=createRequire(import.meta.url)('./application-business-fixture.cjs');
const digest=value=>createHash('sha256').update(value).digest('hex');
const kinds={tencent_docs:'document',agent_mail:'mailbox',feishu_bitable:'table'};
export const businessCases=kind=>[
 {kind,phase:'read',action:{tencent_docs:'document.summarize',agent_mail:'mail.summarize',feishu_bitable:'table.query'}[kind]},
 {kind,phase:'effect',action:{tencent_docs:'document.create',agent_mail:'mail.send',feishu_bitable:'table.export'}[kind]},
].map(value=>({...value,marker:`OWNED_BUSINESS_${kind}_${value.phase}`}));
export function businessPolicies(kind,{lookups=false}={}){
 const uri=`owned-application://${kinds[kind]}/original`;
 return Object.fromEntries(createBusinessFixture(kind,uri,()=>{},{lookups}).tools.map(tool=>{
  const meta=tool._meta['io.kcoder.applicationBusiness'],template={},fields={};
  for(const [name,property]of Object.entries(tool.inputSchema.properties)){
   template[name]=null;
   if(name==='resourceUri'||name==='operationId')continue;
   if(property.const!==undefined){template[name]=property.const;continue;}
   fields['/'+name]=property.type==='integer'?{type:'integer',minimum:property.minimum,maximum:property.maximum}:{type:'string',max_bytes:property.maxLength??256,...(property.enum?{allowed_values:property.enum}:{})};
  }
  return [tool.name,{action:meta.action,schema_sha256:digest(JSON.stringify(tool.inputSchema)),resource_uri_input_pointer:'/resourceUri',...(meta.operationIdInputPointer?{operation_id_input_pointer:'/operationId'}:{}),input_template:template,fields}];
 }));
}
function parseTool(message){
 if(message.role!=='tool')return null;
 const content=typeof message.content==='string'?message.content:message.content.map(block=>block.text??'').join('');try{return JSON.parse(content);}catch{return {protocolErrorText:content.slice(0,400)};}
}
export function createBusinessProtocol(){
 const observations=[],errors=[];let active=null;
 const select=(value,operationId)=>{active={...value,operationId,effectReady:false,uri:`owned-application://${kinds[value.kind]}/original`};};
 function respond({body,requestNumber}){
  try{
   assert.ok(active);assert.ok(requestNumber<=24,'One bounded six-task protocol, no hidden model work');
   const original=JSON.parse(body.messages.find(message=>message.role==='user').content);
   assert.equal(original.originalOperationId,active.operationId);assert.ok(original.task.includes(active.marker));
   assert.deepEqual(original.selectedResourceUris,[active.uri]);assert.equal(original.untrustedSourceData,true);
   const tools=(body.tools??[]).map(tool=>tool.function??tool);
   assert.ok(tools.length>0&&tools.every(tool=>tool.name.startsWith('mcp__owned-')||tool.name.startsWith('mcp__owned_')));
   if(active.phase==='read')assert.ok(!tools.some(tool=>/__(mail_send|document_create|table_export)$/.test(tool.name)),'Read tasks never expose an effect');
   const results=body.messages.map(parseTool).filter(Boolean),step=results.length,resourceUri=active.uri,operationId=active.operationId;
   assert.ok(results.every(result=>result.applicationResult),'Original tool error must stop the controlled protocol; do not replay it');
   const previous=results.at(-1)?.applicationResult;
   let raw,args;
   if(active.kind==='tencent_docs'&&active.phase==='read'&&step===0){raw='document_read';args={resourceUri,documentId:'original'};}
   if(active.kind==='tencent_docs'&&active.phase==='effect'){
    if(step===0){raw='document_create';args={resourceUri,operationId,title:'Owned review',body:'Owned approved document: 37 units.'};}
    else if(step===1){assert.equal(results[0].businessComplete,false);assert.equal(results[0].contentVerified,false);raw='document_read';args={resourceUri,documentId:previous.documentId};}
    else {assert.equal(previous.createdOperationId,operationId);assert.equal(previous.title,'Owned review');assert.equal(previous.body,'Owned approved document: 37 units.');}
   }
   if(active.kind==='agent_mail'&&active.phase==='read'){
    if(step===0){raw='mail_list';args={resourceUri,limit:1};}
    else if(step===1){raw='mail_read';args={resourceUri,messageId:previous.items[0].messageId};}
    else if(step===2){raw='mail_attachment';args={resourceUri,messageId:previous.messageId,attachmentId:previous.attachmentIds[0]};}
    else {assert.equal(previous.preview,'item,units\nowned,37\n');assert.equal(results.at(-1).manifest.sha256,digest(Buffer.from(previous.preview)));assert.equal(Object.hasOwn(previous,'base64'),false);}
   }
   if(active.kind==='agent_mail'&&active.phase==='effect'&&step===0){raw='mail_send';args={resourceUri,operationId,to:'owned-recipient@example.invalid',subject:'Owned review',body:'Owned approved send: 37 units.'};}
   if(active.kind==='feishu_bitable'&&step===0){
    raw=active.phase==='read'?'table_query':'table_export';args={resourceUri,...(active.phase==='effect'?{operationId}:{}),limit:1,region:'owned-east'};
   }
   observations.push({requestNumber,marker:active.marker,step,tool:raw??null,operationId,previousManifest:results.at(-1)?.manifest??null,previousOperationReceipt:results.at(-1)?.operationReceipt??null});
   if(!raw)return [{delta:{role:'assistant',content:`OWNED_BUSINESS_CONFIRMED_${active.marker}`}},{finishReason:'stop'}];
   const matching=tools.filter(tool=>tool.name.endsWith('__'+raw));assert.equal(matching.length,1,'Use exactly the actual registered tool definition');
   const selected=active;
   return [...(active.phase==='effect'&&step===0?[{ready:()=>selected.effectReady}]:[]),{delta:{role:'assistant',tool_calls:[{index:0,id:`owned-business-${requestNumber}`,type:'function',function:{name:matching[0].name,arguments:JSON.stringify(args)}}]}},{finishReason:'tool_calls'}];
  }catch(error){errors.push({requestNumber,code:error.code??'BUSINESS_PROTOCOL_INVALID',message:String(error.message).slice(0,400),lastToolResult:String(body.messages.filter(message=>message.role==='tool').at(-1)?.content??'').slice(0,1000)});return [{delta:{role:'assistant',content:'OWNED_BUSINESS_PROTOCOL_UNCONFIRMED'}},{finishReason:'stop'}];}
 }
 return {select,respond,observations,errors,releaseEffect(operationId){assert.equal(active.operationId,operationId);active.effectReady=true;}};
}
