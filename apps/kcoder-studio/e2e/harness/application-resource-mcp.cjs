// Controlled native protocol source. This is not a branded external account.
const {appendFileSync,readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {createInterface}=require('node:readline');
const [kind,log,mode]=process.argv.slice(2);
const bindings=mode==='task-resource-bindings';
const businessMode=['office-business','office-business-app-only','office-business-lost-create-ack','office-business-lost-create-hard-drop'].includes(mode);
const lookupMode=mode==='office-business-lost-create-ack'||mode==='office-business-lost-create-hard-drop';
const definitions={
  tencent_docs:{kind:'document',text:'OWNED_DOC_START\nDocument reviewed total: 37 units.\nOWNED_DOC_END'},
  agent_mail:{kind:'mailbox',text:'OWNED_MAIL_START\nFrom: owned-sender@example.invalid\nSubject: Fixture review\nReviewed total: 37 units.\nOWNED_MAIL_END'},
  feishu_bitable:{kind:'table',text:'{"marker":"OWNED_TABLE","rows":[{"region":"owned-east","reviewedUnits":37}]}'}
};
if(!definitions[kind]||!log)process.exit(2);
const selected=definitions[kind],uri=`owned-application://${selected.kind}/original`;
const deniedUri=`owned-application://${selected.kind}/unselected`,uiUri='ui://owned-application/document';
const readSchema={additionalProperties:false,properties:{uri:{type:'string'}},required:['uri'],type:'object'};
const sha=text=>createHash('sha256').update(text).digest('hex');
const business=businessMode?require('./application-business-fixture.cjs').createBusinessFixture(kind,uri,row=>appendFileSync(log,JSON.stringify(row)+'\n'),{lookups:lookupMode}):null;
if(mode==='office-business-app-only'){
  for(const tool of business.tools)if(tool.name==='document_create')tool._meta.ui={resourceUri:'ui://owned-application/create',visibility:['app']};
}
const start=()=>{try{return readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ')[19];}catch{return null;}};
appendFileSync(log,JSON.stringify({event:'started',pid:process.pid,startTicks:start(),kind})+'\n',{mode:0o600});
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:`owned-${kind}`,version:'1'}};
  else if(request.method==='tools/list'){
    result={tools:business?business.tools:bindings?[{name:'read_document',description:'Read the exact reviewed URI',inputSchema:readSchema,annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:uiUri,visibility:['model','app']}}},{name:'read_deferred',description:'Reviewed deferred reader for the same exact URI',inputSchema:readSchema,annotations:{readOnlyHint:true}}]:[{name:'owned_source_probe',description:'Controlled registered source; no invocation needed for resource reads',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};
    if(business)appendFileSync(log,JSON.stringify({event:'businessInventory',kind,tools:business.tools})+'\n');
  }
  else if(request.method==='resources/list')result={resources:[{uri,name:`Owned ${selected.kind}`,mimeType:'text/plain',_meta:{'io.kcoder.applicationResource':{kind:selected.kind}}},...(bindings?[{uri:deniedUri,name:'Owned unselected document',mimeType:'text/plain',_meta:{'io.kcoder.applicationResource':{kind:'document'}}}]:[])]};
  else if(business&&request.method==='tools/call'){
    try{const value=business.invoke(request.params?.name,request.params?.arguments);
      if(lookupMode&&request.params?.name==='document_create'){
       appendFileSync(log,JSON.stringify({event:'businessAckSuppressed',kind,requestId:request.id,operationId:request.params.arguments.operationId})+'\n');
       if(mode==='office-business-lost-create-hard-drop')process.exit(0);
       return;
      }
      result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
    catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
  }
  else if(bindings&&request.method==='tools/call'&&['read_document','read_deferred'].includes(request.params?.name)){
    const target=request.params.arguments?.uri;
    appendFileSync(log,JSON.stringify({event:'toolRead',kind,uriSha256:sha(String(target)),allowedFixtureUri:target===uri})+'\n');
    result={content:[{type:'text',text:target===uri?selected.text:'OWNED_UNSELECTED_DOCUMENT'}]};
  }
  else if(bindings&&request.method==='resources/read'&&request.params?.uri===uiUri){
    appendFileSync(log,JSON.stringify({event:'uiRead',kind})+'\n');
    result={contents:[{uri:uiUri,mimeType:'text/html;profile=mcp-app',text:'<!doctype html><html><body><p>Owned document view</p></body></html>',_meta:{ui:{csp:{},permissions:{}}}}]};
  }
  else if(bindings&&request.method==='resources/read'&&request.params?.uri===deniedUri){
    appendFileSync(log,JSON.stringify({event:'unselectedResourceRead',kind})+'\n');
    result={contents:[{uri:deniedUri,mimeType:'text/plain',text:'OWNED_UNSELECTED_DOCUMENT'}]};
  }
  else if(request.method==='resources/read'&&request.params?.uri===uri){
    appendFileSync(log,JSON.stringify({event:'resourceRead',kind,uriSha256:sha(uri),bytes:Buffer.byteLength(selected.text),sha256:sha(selected.text)})+'\n');
    result={contents:[{uri,mimeType:'text/plain',text:selected.text}]};
  } else if(request.method==='ping')result={};
  else {
    appendFileSync(log,JSON.stringify({event:'unexpectedMethod',method:String(request.method).slice(0,80)})+'\n');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Owned read-only fixture method unavailable'}})+'\n');return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
lines.on('close',()=>process.exit(0));
