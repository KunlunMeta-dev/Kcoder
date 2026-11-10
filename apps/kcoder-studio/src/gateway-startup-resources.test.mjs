import test from 'node:test';
import assert from 'node:assert/strict';
import { captureGatewayStartupResources } from './gateway-startup-resources.js';
import { createGatewayStartupObservation } from './gateway-startup-observation.js';
import { nativeOfficeEnvironmentKey } from './integrations/office/resource-host.mjs';
import { nativeConnectivityEnvironmentKey } from './integrations/connectivity/resource-host.mjs';
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function observer(){return createGatewayStartupObservation({emit(){}});}
test('both real private captures consume reserved inputs synchronously before any asynchronous continuation',async t=>{
  t.mock.method(console,'warn',()=>{});
  const environment={[nativeOfficeEnvironmentKey]:'invalid-office',kcoder_native_office_binding_v1:'alias',[nativeConnectivityEnvironmentKey]:'invalid-channel',kcoder_native_connectivity_binding_v1:'alias',PATH:'/owned'};
  const running=captureGatewayStartupResources({observation:observer(),environment});
  assert.deepEqual(environment,{PATH:'/owned'});
  assert.deepEqual(await running,{office:null,channel:null});
});
test('capture starts both independent domains before awaiting either and preserves their brands',async()=>{
  const a=deferred(),b=deferred(),calls=[],office=Object.freeze({office:true}),channel=Object.freeze({channel:true});
  const running=captureGatewayStartupResources({observation:observer(),office:()=>{calls.push('office');return a.promise;},channel:()=>{calls.push('channel');return b.promise;}});
  assert.deepEqual(calls,['channel','office']);b.resolve(channel);a.resolve(office);
  const result=await running;assert.equal(result.office,office);assert.equal(result.channel,channel);
});
test('a failed capture is isolated while every already-started sibling is joined',async()=>{
  const a=deferred(),b=deferred(),warnings=[];let finished=false;
  const running=captureGatewayStartupResources({observation:observer(),office:()=>a.promise,channel:()=>b.promise,warn:code=>warnings.push(code)}).then(result=>{finished=true;return result;});
  a.reject(Error('private-launch-body'));await Promise.resolve();await Promise.resolve();assert.equal(finished,false);
  const channel={};b.resolve(channel);assert.deepEqual(await running,{office:null,channel});assert.deepEqual(warnings,['OFFICE_NATIVE_UNAVAILABLE']);
});
test('diagnostic failure does not replace the other native capture result',async()=>{
  const channel={};const result=await captureGatewayStartupResources({observation:observer(),office:()=>{throw Error('bad-domain');},channel:()=>channel,warn:()=>{throw Error('closed-sink');}});
  assert.equal(result.office,null);assert.equal(result.channel,channel);
});
