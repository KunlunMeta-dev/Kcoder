import { canonical } from '../validation.mjs';
import { requireValue } from '../errors.mjs';

const REPORT_FIELDS=['capabilityId','state','businessValidated','evidence'];
const EVIDENCE_FIELDS=['verifierId','verifierVersion','toolRef','resourceRefs','identityGeneration','targetRevision','policyRevision','requestRevision','inputSha256','resultSha256','observedAtMs','checkName'];
const READONLY_CAPABILITIES=['document.read','mail.list','mail.read','table.read','table.query'];
function exactKeys(value,fields){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key));}
function unknown(capabilityId){return {capabilityId,state:'unknown',businessValidated:false,evidence:null};}
export function validateProbeReport(expected,report,{now=()=>Date.now()}={}){
  if(!exactKeys(report,REPORT_FIELDS)||report.capabilityId!==expected.capabilityId||!['verified','failed','unknown'].includes(report.state)||typeof report.businessValidated!=='boolean')return unknown(expected.capabilityId);
  if(report.state!=='verified'&&report.businessValidated!==false)return unknown(expected.capabilityId);
  if(report.evidence==null)return report.state==='verified'?unknown(expected.capabilityId):{...report,evidence:null};
  const evidence=report.evidence;
  if(report.state==='verified'&&report.businessValidated!==true||!exactKeys(evidence,EVIDENCE_FIELDS)||Object.keys(evidence).length!==EVIDENCE_FIELDS.length)return unknown(expected.capabilityId);
  if(['verifierId','verifierVersion','policyRevision','requestRevision','checkName'].some(key=>typeof evidence[key]!=='string'||!evidence[key].length||evidence[key].length>256))return unknown(expected.capabilityId);
  if(evidence.identityGeneration!==expected.scope.identityGeneration||evidence.targetRevision!==expected.scope.targetRevision||evidence.requestRevision!==expected.requestRevision||canonical(evidence.toolRef)!==canonical(expected.toolRef)||canonical(evidence.resourceRefs)!==canonical(expected.resourceRefs))return unknown(expected.capabilityId);
  if(![evidence.inputSha256,evidence.resultSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||!Number.isSafeInteger(evidence.observedAtMs)||evidence.observedAtMs<expected.startedAtMs||evidence.observedAtMs>now()+5000)return unknown(expected.capabilityId);
  return {capabilityId:report.capabilityId,state:report.state,businessValidated:report.state==='verified',evidence};
}
export function createReadinessVerifiers(call){
  return new Map(READONLY_CAPABILITIES.map(capabilityId=>[capabilityId,{readOnly:true,async run(input){
    requireValue(input.matches.length===1,'CAPABILITY_SOURCE_AMBIGUOUS','repair_configuration');
    const toolRef=Object.fromEntries(['name','schemaRevision','sourceRevision'].map(key=>[key,input.matches[0][key]]));
    const expected={capabilityId,scope:input.scope,toolRef,resourceRefs:input.resourceRefs??[],requestRevision:input.requestRevision,startedAtMs:Date.now()};
    const result=await call('private.readiness.verify',{scope:input.scope,operationId:input.operationId,payload:{capabilityId,...(input.connectionId?{connectionId:input.connectionId}:{}),resourceRefs:expected.resourceRefs,toolRef}});
    return validateProbeReport(expected,result);
  }}]));
}
