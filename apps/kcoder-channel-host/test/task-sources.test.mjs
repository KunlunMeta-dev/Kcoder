import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taskSourceCatalog,taskCapabilitySourceDescriptor } from '../src/applications/task-sources.mjs';
import { CONTRACT_DOMAINS, domainFile, mergeContractDomains } from '../../../scripts/contracts/domains.mjs';
const descriptor={sourceRef:{id:'configured-native-source',revision:'security-1'},accountRef:null,kind:'mcp',displayName:'Configured source',accountDisplayName:null,state:'ready',reasonCode:null,capabilities:['tools']};
test('task source consumers use the Root generated descriptor fixtures',()=>{
 const examples=mergeContractDomains(Object.fromEntries(CONTRACT_DOMAINS.map(domain=>[domain,JSON.parse(readFileSync(new URL(`../../kcoder-studio/shared/generated/${domainFile('examples',domain)}`,import.meta.url),'utf8'))])));
 for(const item of examples.IntegrationTaskCapabilitySourceDescriptor)assert.deepEqual(taskCapabilitySourceDescriptor(item.value),item.decoded);
});
test('unknown native catalog is distinct from a real empty catalog and revisions are not invented',()=>{
 assert.equal(taskSourceCatalog({tools:[]}).taskSourcesState,'unknown');
 assert.equal(taskSourceCatalog({taskSources:[]}).taskSourcesState,'observed');
 const result=taskSourceCatalog({taskSources:[descriptor]});assert.equal(result.taskSources[0].sourceRef.revision,'security-1');assert.equal(result.taskSources[0].accountRef,null);
});
test('raw credentials, missing account null and fake ready source without capability are rejected',()=>{
 for(const bad of [{...descriptor,credential:'not-permitted'},{...descriptor,accountRef:undefined},{...descriptor,capabilities:[]},{...descriptor,state:'unknown',reasonCode:null}])assert.throws(()=>taskSourceDescriptor(bad));
});
