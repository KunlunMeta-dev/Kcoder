import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProbeReport,createReadinessVerifiers } from '../src/applications/readiness-probe.mjs';
const expected={capabilityId:'document.read',scope:{accountId:'owner',targetId:'target',workspaceId:null,identityGeneration:'native-generation',targetRevision:'native-target'},toolRef:{name:'exact-native-tool',schemaRevision:'schema-1',sourceRevision:'source-1'},resourceRefs:[{kind:'artifact',id:'native-resource',revision:'1'}],requestRevision:'native-request-1',startedAtMs:1000};
const evidence={verifierId:'native-document-read',verifierVersion:'1',toolRef:expected.toolRef,resourceRefs:expected.resourceRefs,identityGeneration:expected.scope.identityGeneration,targetRevision:expected.scope.targetRevision,policyRevision:'native-policy-1',requestRevision:expected.requestRevision,inputSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),observedAtMs:1100,checkName:'native-fixed-document-record'};
test('L6 only accepts full native evidence tied to exact source, resource, scope and request',()=>{
 const result=validateProbeReport(expected,{capabilityId:expected.capabilityId,state:'verified',businessValidated:true,evidence},{now:()=>1200});assert.equal(result.state,'verified');
});
for(const [name,patch]of [['generation',{identityGeneration:'stale'}],['target',{targetRevision:'stale'}],['request',{requestRevision:'stale'}],['tool',{toolRef:{...expected.toolRef,name:'unrelated-tool'}}],['resource',{resourceRefs:[]}],['time',{observedAtMs:900}],['hash',{resultSha256:'not-a-digest'}],['raw-data',{rawRows:[{secret:'must not leak'}]}]])test('L6 downgrades '+name+' mismatch to unknown without leaking evidence',()=>{
 const result=validateProbeReport(expected,{capabilityId:expected.capabilityId,state:'verified',businessValidated:true,evidence:{...evidence,...patch}},{now:()=>1200});assert.equal(result.state,'unknown');assert.equal(result.businessValidated,false);assert.equal(result.evidence,null);
});
test('completed or error-free tool output cannot stand in for business-validated probe evidence',()=>{
 for(const report of [{capabilityId:expected.capabilityId,state:'completed',businessValidated:true,evidence},{capabilityId:expected.capabilityId,state:'verified',businessValidated:false,evidence},{capabilityId:expected.capabilityId,state:'failed',businessValidated:true,evidence:null},{capabilityId:expected.capabilityId,state:'verified',businessValidated:true,evidence:null}])assert.equal(validateProbeReport(expected,report).state,'unknown');
});
test('readonly probe consumers never forward arbitrary tool args or invoke a model',async()=>{
 let sent;const verifier=createReadinessVerifiers(async(method,params)=>{sent={method,params};return {capabilityId:'document.read',state:'unknown',businessValidated:false,evidence:null};}).get('document.read');
 const result=await verifier.run({scope:expected.scope,matches:[expected.toolRef],operationId:'probe',connectionId:'connection',resourceRefs:expected.resourceRefs,requestRevision:expected.requestRevision});assert.equal(result.state,'unknown');
 assert.deepEqual(Object.keys(sent.params.payload).sort(),['capabilityId','connectionId','resourceRefs','toolRef']);assert.equal(sent.method,'private.readiness.verify');assert.equal(createReadinessVerifiers(()=>{}).has('document.create'),false);
});
