// Owned application business objects. No vendor or real external account is used.
const {createHash}=require('node:crypto');
const sha=value=>createHash('sha256').update(value).digest('hex');
const scalar={type:'string',minLength:1,maxLength:65536};
const bound={type:'integer',minimum:1,maximum:10};
function createBusinessFixture(kind,uri,record,{lookups=false}={}){
 const base={resourceUri:{type:'string',const:uri}};
 const specs={
  tencent_docs:[['document_read','document.read',{...base,documentId:scalar},true],['document_create','document.create',{...base,operationId:scalar,title:scalar,body:scalar},false]],
  agent_mail:[['mail_list','mail.list',{...base,limit:bound},true],['mail_read','mail.read',{...base,messageId:scalar},true],['mail_attachment','mail.attachment',{...base,messageId:scalar,attachmentId:scalar},true],['mail_send','mail.send',{...base,operationId:scalar,to:{type:'string',const:'owned-recipient@example.invalid'},subject:scalar,body:scalar},false]],
  feishu_bitable:[['table_query','table.query',{...base,limit:bound,region:{type:'string',enum:['owned-east','owned-west','all']}},true],['table_export','table.export',{...base,operationId:scalar,limit:bound,region:{type:'string',enum:['owned-east','owned-west','all']}},false]],
 }[kind];
 if(!specs)throw new Error('OWNED_BUSINESS_KIND_UNKNOWN');
 if(lookups){const prefix={tencent_docs:'document',agent_mail:'mail',feishu_bitable:'table'}[kind];specs.push([prefix+'_lookup',prefix+'.lookup',{...base,operationId:scalar},true]);}
 const docs=new Map([['original',{title:'Owned original document',body:'Owned original document: 37 units.',createdOperationId:null}]]),receipts=new Map();
 const attachment=Buffer.from('item,units\nowned,37\n');
 const rows=[{id:'row-1',region:'owned-east',reviewedUnits:37},{id:'row-2',region:'owned-west',reviewedUnits:11}];
 const tools=specs.map(([name,action,properties,readOnlyHint])=>({name,description:`Owned ${action}; exact selected resource only`,inputSchema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)},annotations:{readOnlyHint},_meta:{'io.kcoder.applicationBusiness':{version:1,action,resourceUriInputPointer:'/resourceUri',...(!readOnlyHint||action.endsWith('.lookup')?{operationIdInputPointer:'/operationId'}:{})}}}));
 function invoke(name,input){
  const tool=tools.find(tool=>tool.name===name);if(!tool)throw new Error('OWNED_BUSINESS_TOOL_UNKNOWN');
  const schema=tool.inputSchema;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!schema.required.includes(key))||schema.required.some(key=>!Object.hasOwn(input,key)))throw new Error('OWNED_BUSINESS_ARGUMENTS_INVALID');
  for(const [key,rule]of Object.entries(schema.properties)){
   const value=input[key];
   if(rule.type==='string'&&(typeof value!=='string'||!value.length||value.length>(rule.maxLength??65536)))throw new Error('OWNED_BUSINESS_ARGUMENTS_INVALID');
   if(rule.type==='integer'&&(!Number.isSafeInteger(value)||value<rule.minimum||value>rule.maximum))throw new Error('OWNED_BUSINESS_BOUND_REQUIRED');
   if((rule.const!==undefined&&value!==rule.const)||(rule.enum&&!rule.enum.includes(value)))throw new Error('OWNED_BUSINESS_SCOPE_CHANGED');
  }
  if(tool._meta['io.kcoder.applicationBusiness'].action.endsWith('.lookup')){
   const previous=receipts.get(input.operationId);
   let object=previous?structuredClone(previous.result):null;
   if(object&&name==='document_lookup'){
    const saved=docs.get(object.documentId);
    object=saved?{...object,title:saved.title,body:saved.body,bodySha256:sha(saved.body),operationId:saved.createdOperationId}:null;
   }
   const result={operationId:input.operationId,state:object?'found':'not_found',...(object?{object}:{})};
   record({event:'businessLookup',kind,name,input,result});return result;
  }
  const digest=sha(JSON.stringify({name,input}));
  if(input.operationId&&receipts.has(input.operationId)){
   const previous=receipts.get(input.operationId);if(previous.digest!==digest)throw new Error('OWNED_BUSINESS_OPERATION_CHANGED');
   record({event:'businessReceiptRead',kind,name,operationId:input.operationId});return previous.result;
  }
  let result;
  if(name==='document_read'){if(!docs.has(input.documentId))throw new Error('OWNED_DOCUMENT_NOT_FOUND');result={documentId:input.documentId,...docs.get(input.documentId)};}
  else if(name==='document_create'){
   const documentId='doc-'+sha(input.operationId).slice(0,16);docs.set(documentId,{title:input.title,body:input.body,createdOperationId:input.operationId});result={operationId:input.operationId,documentId,title:input.title,body:input.body,bodySha256:sha(input.body),state:'created'};
  }else if(name==='mail_list')result={items:[{messageId:'owned-message',subject:'Owned fixture review',attachmentIds:['owned-attachment']}].slice(0,input.limit)};
  else if(name==='mail_read'){if(input.messageId!=='owned-message')throw new Error('OWNED_MESSAGE_NOT_FOUND');result={messageId:input.messageId,from:'owned-sender@example.invalid',body:'Owned mailbox body: 37 units.',attachmentIds:['owned-attachment']};}
  else if(name==='mail_attachment'){if(input.messageId!=='owned-message'||input.attachmentId!=='owned-attachment')throw new Error('OWNED_ATTACHMENT_NOT_FOUND');result={messageId:input.messageId,attachmentId:input.attachmentId,mimeType:'text/csv',name:'owned-attachment.csv',base64:attachment.toString('base64'),bytes:attachment.length,sha256:sha(attachment)};}
  else if(name==='mail_send')result={operationId:input.operationId,messageId:'sent-'+sha(input.operationId).slice(0,16),to:input.to,subject:input.subject,bodySha256:sha(input.body),state:'sent'};
  else{
   const selected=rows.filter(row=>input.region==='all'||row.region===input.region).slice(0,input.limit);result={columns:['id','region','reviewedUnits'],rows:selected,rowCount:selected.length,limit:input.limit,region:input.region};
   if(name==='table_export'){
    const text='id,region,reviewedUnits\n'+selected.map(row=>`${row.id},${row.region},${row.reviewedUnits}\n`).join('');
    result={...result,operationId:input.operationId,exportId:'export-'+sha(input.operationId).slice(0,16),mimeType:'text/csv',base64:Buffer.from(text).toString('base64'),bytes:Buffer.byteLength(text),sha256:sha(text),state:'exported'};
   }
  }
  if(input.operationId)receipts.set(input.operationId,{digest,result});
  record({event:tool.annotations.readOnlyHint?'businessRead':'businessEffect',kind,name,input,result});return result;
 }
 return {tools,invoke};
}
module.exports={createBusinessFixture};
