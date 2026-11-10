// Controlled Provider selections only; actual Native Office generates every byte.
const assert=require('node:assert/strict');
function createOfficeResponder(protocol,seed){
 const specification=protocol.claimSpecification(seed);let requests=0,generated;const errors=[];
 return {
  next(body){
   if(!JSON.stringify(body.messages??[]).includes(protocol.claimPrompt))return null;
   requests++;if(requests>8)throw Error('WINDOWS_OFFICE_PROVIDER_BUDGET_EXCEEDED');
   try{
    const result=protocol.toolResult(body,protocol.documentCall);
    if(result){assert.equal(result.format,'docx');assert.ok(result.artifactRef?.id);assert.match(result.sha256,/^[a-f0-9]{64}$/);
     assert.ok(!JSON.stringify(body.messages).includes(specification.paragraphs[1].text),'Canonical text was not projected');generated=result;
     return[{delta:{content:'Actual native Windows DOCX ready for collection.'}},{finishReason:'stop'}];}
    if(protocol.toolResult(body,protocol.discoveryCall)){
     assert.equal(protocol.discoveryResult(body).tools[0].name,'OfficeDocument');
     return protocol.toolSteps(protocol.documentCall,'tool_execute',{tool_name:'OfficeDocument',arguments:{specification,sourceRefs:[]}});
    }
    return protocol.toolSteps(protocol.discoveryCall,'tool_search',{query:'OfficeDocument',limit:1});
   }catch(error){errors.push(String(error.message).slice(0,256));throw error;}
  },
  metrics(){return{requests,generated,errors:[...errors],qualityClaim:false,externalModelCalls:0};},
 };
}
module.exports={createOfficeResponder};
