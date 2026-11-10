import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubAdapter,githubDeliveryMarker,githubRequest,githubRateLimitWait } from '../src/adapters/github.mjs';
import { githubEvent } from '../src/normalizers.mjs';

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
 const calls=[],comments=[],issueComments=new Map();let listResponse=null,postResponse=null;
 const transport=async(url,options={})=>{
  const parsed=new URL(url);calls.push({method:options.method??'GET',path:parsed.pathname,query:Object.fromEntries(parsed.searchParams),body:options.body});
  assert.equal(parsed.hostname,'api.github.com');assert.match(options.headers.Authorization,/^Bearer inert-test-token$/);
  if(options.method==='POST'){
   const issue=parsed.pathname.split('/')[5];
   if(postResponse)return postResponse({issue,body:options.body.body,store:issueComments});
   const created={id:++nextId,body:options.body.body,user:{login:'kcoder-bot',id:99,type:'User'}};
   issueComments.set(issue,[...(issueComments.get(issue)??[]),created]);return {status:201,headers:{},body:created};
  }
  if(/\/issues\/[0-9]+\/comments$/.test(parsed.pathname))return {status:200,headers:{},body:issueComments.get(parsed.pathname.split('/')[5])??[]};
  if(listResponse){const value=listResponse(parsed);if(value)return value;}
  const since=Date.parse(parsed.searchParams.get('since'));
  return {status:200,headers:{remaining:'4999'},body:comments.filter(value=>Date.parse(value.updated_at)>=since).sort((a,b)=>Date.parse(a.updated_at)-Date.parse(b.updated_at))};
 };
 return {calls,comments,issueComments,transport,setList(value){listResponse=value;},setPost(value){postResponse=value;}};
}
function memoryCheckpoint(){let cursor='';return {saves:0,load:async()=>cursor,async save(value){this.saves++;cursor=value;},get value(){return cursor;}};}
function adapterFor(github,checkpoint,{now=()=>T0}={}){
 const waits=[];
 const wait=(ms,signal)=>{waits.push(ms);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
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
 assert.equal(list.query.sort,'updated');assert.equal(list.query.since,iso(T0));assert.ok(Number(list.query.per_page)<=100);
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
 assert.equal(resumed.query.since,iso(T0+2000),'the query starts at the saved watermark, not at the new process time');
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

// Pipeline: GitHub events reuse the existing inbound -> Native acceptTask ->
// terminal reply flow, with the issue/PR as the topic (lean plan M3-3 rules).
const scope={accountId:'alice',targetId:'target',workspaceId:'workspace',identityGeneration:'1',targetRevision:'1'};
async function ingestComments(store,service,values){
 const github=fakeGithub();github.comments.push(...values);const rows=[];
 const {adapter}=adapterFor(github,memoryCheckpoint());
 await adapter.start(async event=>{rows.push(store.acceptEvent({...event,channelId:'connection'},scope));});await adapter.stop();
 for(const row of rows)await service.processIngress(scope,row.id);
 return rows;
}
