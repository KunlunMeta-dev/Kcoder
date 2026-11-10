// Local deterministic protocol fixture, retained across actual NSIS replacement.
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const ready=process.argv[2];
if(!ready||!fs.existsSync(path.join(path.dirname(ready),'.owner.json')))throw Error('Owned installer directory required');
const requests=[];let office;
const readyOffice=process.argv.includes('--office-native')?import(require('node:url').pathToFileURL((fs.existsSync(path.join(__dirname,'native-download-model.mjs'))?path.join(__dirname,'native-download-model.mjs'):path.join(__dirname,'../suites/office/native-download-model.mjs'))).href).then(protocol=>{office=require('./windows-office-model.cjs').createOfficeResponder(protocol,'owned-windows-office');}):Promise.resolve();
const server=http.createServer((req,res)=>{
 if(req.method==='GET'){
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url==='/metrics'?{requests,...(office?{office:office.metrics()}:{})}:{object:'list',data:[{id:'fixture',object:'model'}]}));return;
 }
 let body='';req.on('data',chunk=>{body+=chunk;if(body.length>4*1024*1024)req.destroy()});
 req.on('end',()=>{
  let value;try{value=JSON.parse(body)}catch{res.writeHead(400);res.end();return}
  requests.push({model:value.model,temperature:value.temperature});if(requests.length>128)requests.shift();
  let steps;
  try{steps=office?.next(value);}catch{res.writeHead(500);res.end('CONTROLLED_OFFICE_PROTOCOL_FAILURE');return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(steps){
   const frame={id:`office-${office.metrics().requests}`,object:'chat.completion.chunk',created:1,model:'fixture'};
   for(const step of steps)res.write(`data: ${JSON.stringify({...frame,choices:[{index:0,delta:step.delta??{},finish_reason:step.finishReason??null}]})}\n\n`);
   res.end('data: [DONE]\n\n');return;
  }
  const frame={id:`installer-${requests.length}`,object:'chat.completion.chunk',created:1,model:'fixture'};
  res.write(`data: ${JSON.stringify({...frame,choices:[{index:0,delta:{role:'assistant',content:'WINDOWS_HISTORY_REPLY'},finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({...frame,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
});
readyOffice.then(()=>server.listen(0,'127.0.0.1',()=>fs.writeFileSync(ready,JSON.stringify({port:server.address().port})))) .catch(()=>{process.stderr.write('CONTROLLED_OFFICE_FIXTURE_UNAVAILABLE\n');process.exitCode=1;});
setTimeout(()=>server.close(),15*60*1000).unref();
