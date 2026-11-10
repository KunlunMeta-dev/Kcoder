import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopSessionRenewal } from './session-renewal.mjs';
const drain = async () => { for(let n=0;n<12;n+=1) await Promise.resolve(); };
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
function clock() {
  let now=0;const timers=new Set();
  return {setTimer(fn,ms){const timer={fn,due:now+ms};timers.add(timer);return timer;},
    clearTimer(timer){timers.delete(timer);},
    advance(ms){now+=ms;for(const timer of [...timers].sort((a,b)=>a.due-b.due)){if(timer.due<=now&&timers.delete(timer))timer.fn();}},
    nextDelay(){return Math.min(...[...timers].map(timer=>timer.due-now));},
    count(){return timers.size;}};
}
function fixture(overrides={}) {
  const timer=clock(),counts={renew:0,install:0,recover:0},warnings=[];
  const state={running:true,gateway:{sessionTtlMs:3000,async renewSession(){counts.renew+=1;}}};
  const owner=createDesktopSessionRenewal({getGateway:()=>state.gateway,canRun:()=>state.running,
    installSession:async()=>{counts.install+=1;},recoverLoginPages:async()=>{counts.recover+=1;},
    warn:message=>warnings.push(message),setTimer:timer.setTimer,clearTimer:timer.clearTimer,...overrides});
  return {owner,state,timer,counts,warnings};
}

test('observed authentication latency reserves renewal headroom without extending the lease',async()=>{
  const f=fixture();f.state.gateway.sessionRenewalDelayMs=250;
  f.owner.installed(f.state.gateway);assert.equal(f.timer.nextDelay(),250);
  f.timer.advance(250);await drain();assert.equal(f.counts.renew,1);
  f.state.gateway.sessionRenewalDelayMs=6000;
  f.owner.installed(f.state.gateway);assert.equal(f.timer.nextDelay(),1500);
  f.state.gateway.sessionRenewalDelayMs=-1;
  f.owner.installed(f.state.gateway);assert.equal(f.timer.nextDelay(),50);f.owner.stop();
});

test('a held login-page load cannot consume later authentication renewals or reenter navigation', async()=>{
  const load=deferred();let navigations=0;
  const f=fixture({recoverLoginPages:()=>{navigations+=1;return load.promise;}});
  f.owner.installed(f.state.gateway);
  for(let n=0;n<4;n+=1){f.timer.advance(1500);await drain();}
  assert.equal(f.counts.renew,4);assert.equal(f.counts.install,4);
  assert.equal(navigations,1);assert.equal(f.timer.count(),1);
  load.resolve();await drain();f.owner.stop();f.timer.advance(30000);await drain();
  assert.equal(f.counts.renew,4);assert.equal(f.timer.count(),0);
});

test('focus and timer requests coalesce while the original authentication request is held',async()=>{
  const gate=deferred();const f=fixture();f.state.gateway.renewSession=()=>{f.counts.renew+=1;return gate.promise;};
  f.owner.installed(f.state.gateway);
  const first=f.owner.renew();assert.equal(f.owner.renew(),first);
  f.timer.advance(1500);await drain();assert.equal(f.counts.renew,1);
  gate.resolve();await first;await drain();assert.equal(f.counts.install,1);assert.equal(f.timer.nextDelay(),1500);
  f.timer.advance(1500);await drain();assert.equal(f.counts.renew,2);f.owner.stop();
});

test('authentication failure retains the original bounded retry instead of a busy loop',async()=>{
  const f=fixture();f.state.gateway.renewSession=async()=>{f.counts.renew+=1;throw Error('offline');};
  await f.owner.renew();await drain();assert.equal(f.counts.install,0);assert.equal(f.counts.recover,0);
  assert.equal(f.timer.nextDelay(),30000);assert.equal(f.warnings.length,1);
  f.timer.advance(29999);await drain();assert.equal(f.counts.renew,1);
  f.timer.advance(1);await drain();assert.equal(f.counts.renew,2);f.owner.stop();
});

test('failed navigation backs off independently while cookie renewals continue',async()=>{
  let recoveries=0;const f=fixture({recoverLoginPages:async()=>{recoveries+=1;throw Error('navigation failed');}});
  await f.owner.renew();await drain();assert.equal(recoveries,1);
  for(let n=0;n<19;n+=1){f.timer.advance(1500);await drain();}
  assert.equal(recoveries,1);assert.equal(f.counts.renew,20);assert.equal(f.warnings.length,1);
  f.timer.advance(1500);await drain();assert.equal(recoveries,2);f.owner.stop();
});

for(const mode of ['stop','quitting','replacement'])test(`late authentication settlement after ${mode} cannot install or restart the old owner`,async()=>{
  const gate=deferred();const f=fixture();f.state.gateway.renewSession=()=>gate.promise;
  const request=f.owner.renew();
  if(mode==='stop')f.owner.stop();
  if(mode==='quitting')f.state.running=false;
  if(mode==='replacement')f.state.gateway={sessionTtlMs:3000,async renewSession(){}};
  gate.resolve();await request;await drain();f.timer.advance(30000);await drain();
  assert.equal(f.counts.install,0);assert.equal(f.counts.recover,0);assert.equal(f.timer.count(),0);
});

for(const mode of ['stop','quitting'])test(`late failed navigation after ${mode} cannot arm retry or restart authentication`,async()=>{
 const navigation=deferred();const f=fixture({recoverLoginPages:()=>navigation.promise});
 await f.owner.renew();await drain();assert.equal(f.counts.renew,1);
 if(mode==='stop')f.owner.stop();else f.state.running=false;
 navigation.reject(Error('late navigation failure'));await drain();
 f.timer.advance(30000);await drain();
 assert.equal(f.counts.renew,1);assert.equal(f.warnings.length,0);assert.equal(f.timer.count(),0);
});

test('replacement cookie scheduling renews the new owner while the old HTTP request stays held',async()=>{
 const oldRequest=deferred(),newRequest=deferred();const f=fixture();
 f.state.gateway.renewSession=()=>oldRequest.promise;
 const oldGateway=f.state.gateway;const oldPending=f.owner.renew();
 let replacementCalls=0;
 const replacement={sessionTtlMs:3000,renewSession(){replacementCalls+=1;return newRequest.promise;}};
 f.state.gateway=replacement;f.owner.installed(replacement);
 f.timer.advance(1500);await drain();assert.equal(replacementCalls,1);
 const newPending=f.owner.renew();assert.equal(replacementCalls,1);
 oldRequest.resolve();await oldPending;await drain();
 assert.equal(f.counts.install,0);assert.equal(f.owner.renew(),newPending);
 assert.equal(replacementCalls,1);assert.notEqual(oldGateway,replacement);
 newRequest.resolve();await newPending;await drain();
 assert.equal(f.counts.install,1);assert.equal(f.timer.nextDelay(),1500);
 f.timer.advance(1500);await drain();assert.equal(replacementCalls,2);f.owner.stop();
});

test('an old-owner failure cannot replace the new owner timer with the old retry',async()=>{
 const oldRequest=deferred();const f=fixture();f.state.gateway.renewSession=()=>oldRequest.promise;
 const oldPending=f.owner.renew();let replacementCalls=0;
 f.state.gateway={sessionTtlMs:3000,async renewSession(){replacementCalls+=1;}};
 f.owner.installed(f.state.gateway);oldRequest.reject(Error('old request failed'));
 await oldPending;await drain();assert.equal(f.timer.nextDelay(),1500);assert.equal(f.warnings.length,0);
 f.timer.advance(1500);await drain();assert.equal(replacementCalls,1);assert.equal(f.counts.install,1);f.owner.stop();
});
