import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {createOfficeTelemetry}=createRequire(import.meta.url)('./windows-office-native-ui.cjs');
test('Office evidence joins the original socket/request and preserves exact thread/turn identity without transcript',()=>{
 const evidence=createOfficeTelemetry();
 evidence.observe('owned','sent',{id:7,method:'integrations/artifact/export',params:{payload:{reference:{id:'original',revision:'2'}}}});
 evidence.observe('peer','received',{id:7,result:{status:'completed',result:{export:{reference:{id:'peer'}}}}});assert.equal(evidence.exports.length,0);
 const result={status:'completed',result:{export:{reference:{id:'original',revision:'2'},bytes:300000,sha256:'a'.repeat(64)}}};
 evidence.observe('owned','received',{id:7,result});assert.deepEqual(evidence.exports,[result]);
 evidence.observe('owned','received',{method:'turn/completed',params:{threadId:'original-thread',turn:{id:'turn-1',status:'completed',messages:[{text:'must not retain transcript'}]}}});
 assert.deepEqual(evidence.turns,[{threadId:'original-thread',turnId:'turn-1',status:'completed'}]);
 evidence.observe('owned','sent',{id:8,method:'attachment/read/chunk',params:{offset:262144,length:1000}});
 evidence.observe('owned','received',{id:8,result:{bytes:'not retained'}});assert.deepEqual(evidence.chunks,[{offset:262144,length:1000}]);
});
test('failed original turns retain bounded Native codes without messages or Provider bodies',()=>{
 const evidence=createOfficeTelemetry();
 evidence.observe('owned','received',{method:'turn/completed',params:{threadId:'original-thread',turn:{id:'turn-2',status:'failed'},error:{code:-32010,message:'TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE:TASK_CAPABILITY_SCOPE_OWNER_WITNESS private message must not be retained',details:null}}});
 assert.deepEqual(evidence.turns,[{threadId:'original-thread',turnId:'turn-2',status:'failed',error:{code:-32010,nativeCodes:['TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE','TASK_CAPABILITY_SCOPE_OWNER_WITNESS'],providerDetailsPresent:false}}]);
});
test('native export observations retain only the original receipt metadata',()=>{
 const evidence=createOfficeTelemetry();
 evidence.observe('owned','sent',{id:1,method:'integrations/artifact/export'});
 evidence.observe('owned','received',{id:1,result:{status:'completed',result:{manifest:{presentation:{paragraphs:['must not retain source text']}},export:{reference:{id:'original',revision:1},bytes:300000,sha256:'a'.repeat(64),privateReaderLease:'must not retain reader lease'}}}});
 assert.deepEqual(evidence.exports,[{status:'completed',result:{export:{reference:{id:'original',revision:1},bytes:300000,sha256:'a'.repeat(64)}}}]);
});
