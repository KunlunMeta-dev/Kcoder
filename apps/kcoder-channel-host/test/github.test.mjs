import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubAdapter,githubRequest,githubRateLimitWait,validateGithubConfigurationDraft } from '../src/adapters/github.mjs';
import { githubEvent } from '../src/normalizers.mjs';
import { ChannelStore } from '../src/channels/store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Lean plan M4. All GitHub traffic goes through an owned fake transport; no
// real account, token or network is involved.
const T0=Date.parse('2026-11-04T08:00:00Z');
const configuration={channelId:'connection',botLogin:'kcoder-bot',repositories:['Owner/Repo'],pollIntervalSeconds:60};
const iso=ms=>new Date(ms).toISOString();
let nextId=1000;
function comment({id=++nextId,login='alice',userId=1,type='User',body='@kcoder-bot please fix the flaky test',issue=7,created=T0+1000,updated=created,app=null}={}){
 return {id,body,user:{login,id:userId,type},issue_url:'https://api.github.com/repos/owner/repo/issues/'+issue,created_at:iso(created),updated_at:iso(updated),performed_via_github_app:app};
}
function fakeGithub(){
 const calls=[],comments=[];let listResponse=null;
 const transport=async(url,options={})=>{
  const parsed=new URL(url);calls.push({method:options.method??'GET',path:parsed.pathname,query:Object.fromEntries(parsed.searchParams),body:options.body});
  assert.equal(parsed.hostname,'api.github.com');assert.match(options.headers?.Authorization??'',/^Bearer inert-test-token$/);
  assert.equal(options.method,'GET');assert.equal(parsed.pathname,'/repos/owner/repo/issues/comments');
  if(listResponse){const value=listResponse(parsed);if(value)return value;}
  const since=Date.parse(parsed.searchParams.get('since'));
  const page=Number(parsed.searchParams.get('page')),size=Number(parsed.searchParams.get('per_page'));
  return {status:200,headers:{remaining:'4999'},body:comments.filter(value=>Date.parse(value.updated_at)>since).sort((a,b)=>Date.parse(a.updated_at)-Date.parse(b.updated_at)).slice((page-1)*size,page*size)};
 };
 return {calls,comments,transport,setList(value){listResponse=value;}};
}
function memoryCheckpoint(){let cursor='';return {saves:0,load:async()=>cursor,async save(value){this.saves++;cursor=value;},get value(){return cursor;}};}
function adapterFor(github,checkpoint,{now=()=>T0}={}){
 const waits=[];
 const wait=(ms,signal)=>{waits.push(ms);assert.ok(signal instanceof AbortSignal);signal.throwIfAborted();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
 const adapter=new GithubAdapter({configuration,credentials:{token:'inert-test-token'},transport:github.transport,checkpoint,now,wait});
 return {adapter,waits};
}

test('a mention starts a task input; ordinary, quoted, bot, CI and self comments do not',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 github.comments.push(
  comment({id:2001,body:'@KCoder-Bot run the test suite and fix failures'}),
  comment({id:2002,body:'No mention here, just discussion.'}),
  comment({id:2003,body:'> @kcoder-bot earlier quote\nI agree'}),
  comment({id:2004,body:'see `@kcoder-bot` in code'}),
  comment({id:2005,login:'github-actions[bot]',type:'Bot',body:'@kcoder-bot CI failed'}),
  comment({id:2006,login:'ci-runner',app:{id:1},body:'@kcoder-bot CI via app'}),
  comment({id:2007,login:'kcoder-bot',userId:99,body:'@kcoder-bot echo of my own reply'}),
  comment({id:2008,login:'review-bot',type:'Bot',body:'@kcoder-bot review comments'}));
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(async event=>{events.push(event);});
 assert.equal(adapter.connectionState(),'connected');
 assert.deepEqual(events.map(event=>event.eventId),['2001']);
 const [event]=events;
 assert.equal(event.platform,'github');assert.equal(event.botId,'kcoder-bot');assert.equal(event.conversationId,'owner/repo');
 assert.equal(event.topicId,'7');assert.equal(event.chatKind,'group');assert.equal(event.senderId,'1');assert.equal(event.kind,'message');
 assert.match(event.text,/^\[GitHub owner\/repo#7 @alice\]\nrun the test suite/);assert.doesNotMatch(event.text,/@kcoder-bot/i);
 assert.ok(!JSON.stringify(event).includes('inert-test-token'));
 const list=github.calls.find(call=>call.path==='/repos/owner/repo/issues/comments');
 assert.equal(list.query.sort,'updated');assert.equal(list.query.since,iso(T0-600000));assert.ok(Number(list.query.per_page)<=100);
});

test('a mentioned /stop command stays a channel control command',()=>{
 const event=githubEvent(configuration,'owner/repo',comment({body:'@kcoder-bot /stop'}));
 assert.equal(event.kind,'control');assert.equal(event.text,'/stop');
});

test('restart resumes from the durable watermark without replaying or skipping comments',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),first=[],second=[];
 github.comments.push(comment({id:3001,created:T0+1000}),comment({id:3002,created:T0+2000,body:'@kcoder-bot second task'}));
 const one=adapterFor(github,checkpoint);
 await one.adapter.start(async event=>{first.push(event.eventId);});await one.adapter.stop();
 assert.deepEqual(first,['3001','3002']);
 const saved=JSON.parse(checkpoint.value).repos['owner/repo'];assert.equal(saved.since,iso(T0+2000));
 // While stopped: one new mention, plus an edit of an old one (same id).
 github.comments.push(comment({id:3003,created:T0+5000,body:'@kcoder-bot third task'}));
 github.comments[0].updated_at=iso(T0+6000);
 const two=adapterFor(github,checkpoint,{now:()=>T0+60*60*1000});t.after(()=>two.adapter.stop());
 await two.adapter.start(async event=>{second.push(event.eventId);});
 assert.deepEqual(second,['3003'],'only the unseen comment is ingested after restart');
 const resumed=github.calls.filter(call=>call.path==='/repos/owner/repo/issues/comments').at(-1);
 assert.equal(resumed.query.since,iso(T0+2000-600000),'the query overlaps the saved watermark, independently of the new process time');
 assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].since,iso(T0+6000));
});

test('an ingest failure leaves the watermark unchanged so the comment is retried, not skipped',async()=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint();
 github.comments.push(comment({id:3101,created:T0+1000}));
 const {adapter}=adapterFor(github,checkpoint);
 await assert.rejects(adapter.start(async()=>{throw Object.assign(new Error('controlled inbox failure'),{code:'INBOX_UNAVAILABLE'});}));
 assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].since,iso(T0));
 assert.deepEqual(JSON.parse(checkpoint.value).repos['owner/repo'].seen,[]);
});

test('normalization failures preserve the watermark until the original configured source is repaired', async t => {
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 github.comments.push(comment({id:3201,created:T0+1000}));
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 adapter.configuration={...configuration};delete adapter.configuration.channelId;
 await assert.rejects(adapter.start(async event=>{events.push(event.eventId);}),{code:'PLATFORM_IDENTITY_MISSING'});
 const failed=JSON.parse(checkpoint.value).repos['owner/repo'];
 assert.equal(failed.since,iso(T0));assert.deepEqual(failed.seen,[]);assert.deepEqual(events,[]);
 adapter.configuration={...configuration};await adapter.start(async event=>{events.push(event.eventId);});
 assert.deepEqual(events,['3201']);
});

test('rate limits back off until the advertised time instead of spinning',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint();let limited=true;
 github.setList(()=>limited?{status:429,headers:{retryAfter:'120'},body:{message:'secondary rate limit'}}:null);
 const {adapter,waits}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(async()=>{});
 assert.equal(adapter.connectionState(),'connected');assert.equal(adapter.connectionFailureReason(),'GITHUB_RATE_LIMITED');
 assert.equal(github.calls.length,1,'no immediate second request');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(waits,[120000]);
 assert.equal(githubRateLimitWait({status:403,headers:{remaining:'0',reset:String((T0+300000)/1000)}},T0),300000);
 assert.equal(githubRateLimitWait({status:200,headers:{remaining:'1',reset:String((T0+90000)/1000)}},T0),90000);
 assert.equal(githubRateLimitWait({status:200,headers:{remaining:'4000'}},T0),0);
 assert.equal(githubRateLimitWait({status:403,headers:{remaining:'10'}},T0),0,'a permission 403 is not a rate limit');
 limited=false;
});

test('the default transport only reaches api.github.com',async()=>{
 await assert.rejects(githubRequest('https://example.invalid/repos/o/r/issues/comments',{fetchImpl:async()=>assert.fail('no request')}),{code:'UNAPPROVED_HOST'});
});

test('exclusive since includes new comments in the watermark second without replaying activation history',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 github.comments.push(comment({id:4000,created:T0-1000}),comment({id:4001,created:T0}));
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(async event=>events.push(event.eventId));
 assert.deepEqual(events,['4001']);
 github.comments.push(comment({id:4002,created:T0}));
 await adapter.pollOnce(async event=>events.push(event.eventId),()=>true,adapter.controller.signal);
 assert.deepEqual(events,['4001','4002']);
});

test('a bounded scan resumes a same-second backlog after restart without advancing over unread pages',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 for(let i=0;i<251;i++)github.comments.push(comment({id:5000+i,created:T0+1000}));
 const one=adapterFor(github,checkpoint);
 await one.adapter.start(async event=>events.push(event.eventId));await one.adapter.stop();
 assert.equal(github.calls.length,4);assert.equal(events.length,200);
 const two=adapterFor(github,checkpoint);t.after(()=>two.adapter.stop());
 await two.adapter.start(async event=>events.push(event.eventId));
 assert.equal(events.length,251);assert.equal(new Set(events).size,251);
 assert.ok(github.calls.length<=8,'each pass has at most four requests');
 assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].since,iso(T0+1000));
 await two.adapter.pollOnce(async event=>events.push(event.eventId),()=>true,two.adapter.controller.signal);
 assert.equal(new Set(events).size,251,'the bounded cache cannot become an authority to skip unseen IDs');
});

test('transport cache eviction still reconciles repeated comments through the durable Inbox', async t => {
 const directory=mkdtempSync(join(tmpdir(),'github-inbox-dedup-')),store=new ChannelStore(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 store.saveConnection({id:'connection',platform:'github',label:'Fixture',configuration:{botLogin:'kcoder-bot',repositories:['owner/repo']}},{token:'inert-test-token'});
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),receipts=[];
 for(let i=0;i<251;i++)github.comments.push(comment({id:11000+i,created:T0+1000}));
 const ingest=async event=>{receipts.push(store.receive('connection',event));};
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(ingest);
 for(let pass=0;pass<4;pass++)await adapter.pollOnce(ingest,()=>true);
 assert.equal(store.db.prepare('SELECT count(*) AS count FROM inbox').get().count,251);
 assert.ok(receipts.some(receipt=>receipt.duplicate),'evicted IDs are reconciled through original durable records');
 assert.equal(receipts.filter(receipt=>!receipt.duplicate).length,251);
});

test('a comment shifted across an offset page remains discoverable in the next overlap pass', async t => {
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 for(let i=0;i<251;i++)github.comments.push(comment({id:10000+i,created:T0+1000}));
 let moved=false;
 github.setList(url=>{
  if(!moved&&url.searchParams.get('page')==='2'){
   github.comments[0].updated_at=iso(T0+2000);moved=true;
  }
  return null;
 });
 const first=adapterFor(github,checkpoint);await first.adapter.start(async event=>{events.push(event.eventId);});await first.adapter.stop();
 const second=adapterFor(github,checkpoint);t.after(()=>second.adapter.stop());
 await second.adapter.start(async event=>{events.push(event.eventId);});
 await second.adapter.pollOnce(async event=>{events.push(event.eventId);},()=>true);
 await second.adapter.pollOnce(async event=>{events.push(event.eventId);},()=>true);
 assert.equal(new Set(events).size,251,'an unobserved comment cannot be discarded because larger IDs were seen');
});

test('malformed durable checkpoints fail before read or overwrite; only a missing repository is newly seeded',async()=>{
 const valid={since:iso(T0),floor:0,seen:[]};
 const values=[null,false,0,'oops',[],{...valid,floor:-1},{...valid,seen:[[0,0]]},{...valid,seen:[[1,-1]]}];
 for(const value of values){
  const github=fakeGithub(),raw=JSON.stringify({v:1,repos:{'owner/repo':value}});let saves=0;
  const {adapter}=adapterFor(github,{load:async()=>raw,save:async()=>{saves++;}});
  await assert.rejects(adapter.start(async()=>{}),{code:'GITHUB_CHECKPOINT_FAILED'});
  assert.equal(saves,0);assert.equal(github.calls.length,0);
 }
 for(const repos of [undefined,null,'oops',[]]){
  const {adapter}=adapterFor(fakeGithub(),{load:async()=>JSON.stringify({v:1,repos})});
  await assert.rejects(adapter.start(async()=>{}),{code:'GITHUB_CHECKPOINT_FAILED'});
 }
 const github=fakeGithub(),checkpoint=memoryCheckpoint();await checkpoint.save(JSON.stringify({v:1,repos:{}}));
 const {adapter}=adapterFor(github,checkpoint);await adapter.start(async()=>{});await adapter.stop();
 assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].since,iso(T0));
});

test('permission, missing-repository and server errors retain their outcome near the quota limit',async()=>{
 for(const [status,code,state] of [[403,'PLATFORM_AUTHORIZATION_FAILED','authorization_required'],[404,'GITHUB_REPOSITORY_UNAVAILABLE','failed'],[503,'PLATFORM_HTTP_REJECTED','degraded']]){
  const github=fakeGithub();github.setList(()=>({status,headers:{remaining:'1',reset:String((T0+300000)/1000)},body:{message:'fixture rejection'}}));
  const {adapter}=adapterFor(github,memoryCheckpoint());
  await assert.rejects(adapter.start(async()=>{}),{code});
  assert.equal(adapter.connectionState(),state);assert.equal(adapter.connectionFailureReason(),code);
 }
});

test('draft validation reports a structured configuration error for a missing object',()=>{
 for(const value of [undefined,null,false,1,'draft',[]])assert.throws(()=>validateGithubConfigurationDraft(value),{code:'GITHUB_CONFIGURATION_INVALID'});
});

test('the authenticated server clock seeds new repositories despite local clock skew',async t=>{
 for(const skew of [-3600000,3600000]){
  const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
  github.setList(parsed=>{
   const since=Date.parse(parsed.searchParams.get('since'));
   return {status:200,headers:{date:new Date(T0).toUTCString()},body:github.comments.filter(value=>Date.parse(value.updated_at)>since)};
  });
  github.comments.push(comment({id:7000,created:T0-1000}),comment({id:7001,created:T0}));
  const {adapter}=adapterFor(github,checkpoint,{now:()=>T0+skew});t.after(()=>adapter.stop());
  await adapter.start(async event=>events.push(event.eventId));
  assert.deepEqual(events,['7001']);assert.equal(github.calls.length,2);
  assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].startedAt,iso(T0));
 }
});

test('legacy version-1 checkpoints still resume with their original watermark and ID deduplication',async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),events=[];
 await checkpoint.save(JSON.stringify({v:1,repos:{'owner/repo':{since:iso(T0+1000),floor:0,seen:[[8000,Math.floor(T0/1000)]]}}}));
 github.comments.push(comment({id:8000,created:T0}),comment({id:8001,created:T0+1000}));
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(async event=>events.push(event.eventId));
 assert.deepEqual(events,['8001']);
});

test('the start signal cancels its owned background wait after readiness', {timeout:2000},async t=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint(),controller=new AbortController();
 const {adapter}=adapterFor(github,checkpoint);t.after(()=>adapter.stop());
 await adapter.start(async()=>{}, {signal:controller.signal});
 const calls=github.calls.length,saves=checkpoint.saves;
 controller.abort();await adapter.loop;
 assert.equal(adapter.connectionState(),'stopped');assert.equal(github.calls.length,calls);assert.equal(checkpoint.saves,saves);
});

test('a future durable watermark fails against the authenticated server clock',async()=>{
 const github=fakeGithub(),checkpoint=memoryCheckpoint();
 await checkpoint.save(JSON.stringify({v:1,repos:{'owner/repo':{since:iso(T0+86400000),floor:0,seen:[]}}}));
 github.setList(()=>({status:200,headers:{date:new Date(T0).toUTCString()},body:[]}));
 const {adapter}=adapterFor(github,checkpoint,{now:()=>T0+86400000});
 await assert.rejects(adapter.start(async()=>assert.fail('no input')),{code:'GITHUB_CHECKPOINT_FAILED'});
 assert.equal(JSON.parse(checkpoint.value).repos['owner/repo'].since,iso(T0+86400000));
});
