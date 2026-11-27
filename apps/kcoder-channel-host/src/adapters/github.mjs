import { setTimeout as sleep } from 'node:timers/promises';
import { requireValue,ChannelError } from '../errors.mjs';
import { boundedJson } from '../transport.mjs';
import { githubEvent,githubRepository,githubLogin } from '../normalizers.mjs';
import { boundedText,httpsUrl } from '../validation.mjs';
import { Octokit } from '@octokit/rest';
import { silentSdkLogger } from '../transport.mjs';

// GitHub issue/PR comment source. Inbound comments are polled over REST;
// results are posted back as a comment on the same issue or pull request.
const HOSTS=['api.github.com'];
// @octokit/rest has no retry/throttling plugin. Outbox owns all send decisions.
const octokit = new Octokit({ log: silentSdkLogger, userAgent: 'KCoder-Channel-Host' });
const PAGE_SIZE=50,MAX_PAGES=4,SEEN_LIMIT=128,GRACE_MS=10*60*1000;
const RECONCILE_PAGE_SIZE=100,RECONCILE_PAGES=5;
const MIN_WAIT_MS=1000,MAX_WAIT_MS=3600*1000;
export const GITHUB_CONNECTION_REASON_CODES=Object.freeze(['GITHUB_RATE_LIMITED','GITHUB_REPOSITORY_UNAVAILABLE','GITHUB_POLL_FAILED','GITHUB_CHECKPOINT_FAILED','GITHUB_INGRESS_FAILED']);
const connectionReasons=new Set(['PLATFORM_AUTHORIZATION_FAILED','PLATFORM_HTTP_REJECTED','PLATFORM_INVALID_JSON','PLATFORM_RESPONSE_TOO_LARGE',...GITHUB_CONNECTION_REASON_CODES]);

/** The hidden marker is the only idempotency evidence GitHub offers for comment creation. */
export function githubDeliveryMarker(deliveryId){
 requireValue(typeof deliveryId==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(deliveryId),'GITHUB_DELIVERY_ID_INVALID');
 return '<!-- kcoder-delivery:'+deliveryId+' -->';
}
/** Public connection configuration; the token is a credential and never appears here. */
export function githubConfiguration(configuration){
 requireValue(configuration&&typeof configuration==='object','GITHUB_CONFIGURATION_INVALID','repair_configuration');
 const botLogin=githubLogin(configuration.botLogin);
 requireValue(Array.isArray(configuration.repositories)&&configuration.repositories.length>0&&configuration.repositories.length<=10,'GITHUB_REPOSITORIES_INVALID','repair_configuration');
 const repositories=[...new Set(configuration.repositories.map(githubRepository))];
 const seconds=configuration.pollIntervalSeconds??60;
 requireValue(Number.isSafeInteger(seconds)&&seconds>=15&&seconds<=3600,'GITHUB_POLL_INTERVAL_INVALID','repair_configuration');
 return {botLogin,repositories,pollIntervalMs:seconds*1000};
}
/** Save-time validation: only fields that are present must be well formed. */
export function validateGithubConfigurationDraft(configuration){
 requireValue(configuration&&typeof configuration==='object'&&!Array.isArray(configuration),'GITHUB_CONFIGURATION_INVALID','repair_configuration');
 if(configuration.botLogin!==undefined)githubLogin(configuration.botLogin);
 if(configuration.repositories!==undefined){requireValue(Array.isArray(configuration.repositories)&&configuration.repositories.length<=10,'GITHUB_REPOSITORIES_INVALID','repair_configuration');configuration.repositories.forEach(githubRepository);}
 if(configuration.pollIntervalSeconds!==undefined)requireValue(Number.isSafeInteger(configuration.pollIntervalSeconds)&&configuration.pollIntervalSeconds>=15&&configuration.pollIntervalSeconds<=3600,'GITHUB_POLL_INTERVAL_INVALID','repair_configuration');
}
/** A reply goes to one configured repository and one issue/PR number, never elsewhere. */
export function githubTarget(configuration,destination){
 const {repositories}=githubConfiguration(configuration);
 const repository=githubRepository(destination?.conversationId);
 requireValue(repositories.includes(repository),'GITHUB_REPOSITORY_NOT_CONFIGURED','repair_configuration');
 requireValue(typeof destination.topicId==='string'&&/^[1-9][0-9]{0,9}$/.test(destination.topicId),'GITHUB_ISSUE_REQUIRED');
 return {repository,number:destination.topicId};
}
/** Bounded REST call; HTTP status is returned to the caller, only transport failures throw. */
export async function githubRequest(url,{method='GET',headers={},body,signal,fetchImpl=fetch,maxBytes=8*1024*1024}={}){
 const target=httpsUrl(url,{allowedHosts:HOSTS});
 let response;
 try {
  response=await octokit.request({method,url:target.href,headers,data:body,
   request:{signal:signal??AbortSignal.timeout(30000),redirect:'error',fetch:async(address,options)=>{
    httpsUrl(address,{allowedHosts:HOSTS});
    const raw=await fetchImpl(address,options),value=await boundedJson(raw,maxBytes);
    // Bound success and error bodies before Octokit decodes either response.
    return new Response(JSON.stringify(value),{status:raw.status,headers:{...Object.fromEntries(raw.headers),'content-type':'application/json'}});
   }}});
 }catch(error){
  if(!error.response){
   const cause=error.cause??error;
   if(cause?.name==='AbortError')throw new DOMException('GitHub request cancelled','AbortError');
   if(cause?.name==='TimeoutError')throw new DOMException('GitHub request timed out','TimeoutError');
   if(cause instanceof ChannelError)throw new ChannelError(cause.code,cause.recovery);
   throw new ChannelError('GITHUB_TRANSPORT_FAILED','reconcile_original');
  }
  response=error.response;
 }
 return {status:response.status,headers:{remaining:response.headers['x-ratelimit-remaining'],reset:response.headers['x-ratelimit-reset'],retryAfter:response.headers['retry-after'],link:response.headers.link,date:response.headers.date},body:response.data};
}
function isRateLimited({status,headers={},body}){
 const remaining=headers.remaining==null?NaN:Number(headers.remaining);
 const retryAfter=headers.retryAfter==null?NaN:Number(headers.retryAfter);
 return status===429||status===403&&(remaining===0||Number.isFinite(retryAfter)&&retryAfter>=0||/\b(?:secondary rate limit|API rate limit exceeded)\b/i.test(String(body?.message??'')));
}
/** Milliseconds to wait before the next request, or 0. Never spins on a limited token. */
export function githubRateLimitWait(response,now=Date.now()){
 const {status,headers={}}=response,remaining=headers.remaining==null?null:Number(headers.remaining);
 const clamp=value=>Math.min(MAX_WAIT_MS,Math.max(MIN_WAIT_MS,value));
 const retryAfter=headers.retryAfter==null?NaN:Number(headers.retryAfter)*1000;
 const untilReset=headers.reset==null?NaN:Number(headers.reset)*1000-now;
 const limited=isRateLimited(response);
 if(limited)return clamp(Number.isFinite(retryAfter)?retryAfter:Number.isFinite(untilReset)?untilReset:60000);
 if(status>=200&&status<300&&remaining!==null&&remaining<=1&&Number.isFinite(untilReset))return clamp(untilReset);
 return 0;
}
function httpError(response,fallback='PLATFORM_HTTP_REJECTED'){
 const status=response.status;
 let code=fallback;
 if(isRateLimited(response))code='GITHUB_RATE_LIMITED';
 else if(status===401||status===403)code='PLATFORM_AUTHORIZATION_FAILED';
 else if(status===404||status===410)code='GITHUB_REPOSITORY_UNAVAILABLE';
 const error=new ChannelError(code,code==='PLATFORM_AUTHORIZATION_FAILED'?'request_authorization':'repair_configuration');
 // Only a definite 4xx rejection proves no effect; server errors stay uncertain.
 error.externalOutcome=status>=400&&status<500?'failed':'unknown';error.httpStatus=status;return error;
}
function parseCursor(raw,repositories,now){
 const valid=value=>requireValue(value,'GITHUB_CHECKPOINT_FAILED','reconcile_original');
 const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
 const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 let saved={v:1,repos:{}};valid(typeof raw==='string');
 if(raw!==''){try{saved=JSON.parse(raw);}catch{throw new ChannelError('GITHUB_CHECKPOINT_FAILED','reconcile_original');}}
 valid(record(saved)&&saved.v===1&&record(saved.repos));
 const repos={};
 for(const repository of repositories){
  // Missing keys are new repositories; malformed stored values never reset history.
  if(!Object.hasOwn(saved.repos,repository)){
   const since=new Date(Math.floor(now/1000)*1000).toISOString();
   repos[repository]={since,startedAt:since,seedPending:true,floor:0,seen:[]};continue;
  }
  const value=saved.repos[repository];
  valid(record(value)&&timestamp(value.since)&&Number.isSafeInteger(value.floor)&&value.floor>=0&&Array.isArray(value.seen)&&value.seen.length<=SEEN_LIMIT&&value.seen.every(entry=>Array.isArray(entry)&&entry.length===2&&entry.every(Number.isSafeInteger)&&entry[0]>value.floor&&entry[1]>=0));
  valid(new Set(value.seen.map(([id])=>id)).size===value.seen.length);
  valid(value.startedAt===undefined||timestamp(value.startedAt));
  valid(value.seedPending===undefined||typeof value.seedPending==='boolean');
  // Legacy cursors only prove their watermark, not an earlier activation time.
  const startedAt=value.startedAt??value.since;
  valid(Date.parse(startedAt)<=Date.parse(value.since));
  if(value.seedPending)valid(value.floor===0&&value.seen.length===0&&value.scan===undefined&&startedAt===value.since);
  repos[repository]={since:value.since,startedAt,floor:0,seen:value.seen.map(entry=>[...entry]),...(value.seedPending?{seedPending:true}:{})};
  if(value.scan!==undefined){
   const scan=value.scan;
   valid(record(scan)&&timestamp(scan.since)&&Date.parse(scan.since)===Date.parse(value.since)-GRACE_MS&&Number.isSafeInteger(scan.page)&&scan.page>=1&&timestamp(scan.latest)&&Date.parse(scan.latest)>=Date.parse(value.since)&&Number.isSafeInteger(scan.floor)&&scan.floor>=value.floor);
   repos[repository].scan={...scan,floor:0};
  }
 }
 return {v:1,repos};
}
export class GithubAdapter {
 constructor({configuration,credentials,transport=githubRequest,checkpoint,now=()=>Date.now(),wait=(ms,signal)=>sleep(ms,undefined,{signal})}){
  this.configuration=configuration;this.credentials=credentials;this.http=transport;this.checkpoint=checkpoint;this.now=now;this.wait=wait;
  this.state='stopped';this.generation=0;this.controller=null;this.loop=null;this.ingest=null;this.connectionObserver=null;this.failureReason=null;this.cursor=null;this.lastWaitMs=0;this.unlinkSignal=null;
 }
 setConnectionObserver(listener){this.connectionObserver=listener;}
 connectionState(){return this.state;}
 connectionFailureReason(){return this.failureReason;}
 observe(state){if(this.state===state)return;this.state=state;this.connectionObserver?.();}
 settings(){return githubConfiguration(this.configuration);}
 headers(){
  requireValue(typeof this.credentials?.token==='string'&&this.credentials.token.length>0,'AUTHORIZATION_REQUIRED','request_authorization');
  return {Accept:'application/vnd.github+json',Authorization:'Bearer '+this.credentials.token,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'KCoder-Channel-Host','Content-Type':'application/json'};
 }
 request(operation,parameters,options={}){
  const request=octokit.rest.issues[operation].endpoint(parameters);
  return this.http(request.url,{...options,method:request.method,
   ...(request.body===undefined?{}:{body:request.body}),headers:this.headers()});
 }
 async start(ingest,{signal}={}){
  const settings=this.settings();this.headers();
  this.unlinkSignal?.();this.unlinkSignal=null;
  this.ingest=ingest;const generation=++this.generation,controller=new AbortController();this.controller=controller;
  const current=()=>generation===this.generation&&!controller.signal.aborted&&!signal?.aborted;
  this.failureReason=null;this.observe('starting');
  if(signal){
   const cancel=()=>{controller.abort(signal.reason);if(generation===this.generation){this.unlinkSignal?.();this.unlinkSignal=null;this.observe('stopped');}};
   this.unlinkSignal=()=>signal.removeEventListener('abort',cancel);
   if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  }
  try{
   requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   this.cursor=parseCursor(await this.checkpoint?.load?.()??'',settings.repositories,this.now());requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   // Persist the starting watermark before any read so a restart cannot skip.
   await this.checkpoint?.save?.(JSON.stringify(this.cursor));requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   const first=await this.pollOnce(ingest,current,AbortSignal.any([controller.signal,...(signal?[signal]:[])]));requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   this.observe('connected');this.loop=this.poll(ingest,controller,generation,first.waitMs);
  }catch(error){
   if(generation===this.generation){this.unlinkSignal?.();this.unlinkSignal=null;}
   if(generation===this.generation&&!controller.signal.aborted){this.failureReason=connectionReasons.has(error?.code)?error.code:'GITHUB_POLL_FAILED';this.observe(error?.code==='PLATFORM_AUTHORIZATION_FAILED'?'authorization_required':error?.code==='GITHUB_REPOSITORY_UNAVAILABLE'?'failed':'degraded');}
   throw error;
  }
 }
 /** One bounded pass over every configured repository. Returns the next backoff. */
 async pollOnce(ingest,current,signal){
  const {repositories}=this.settings();let waitMs=0;
  for(const repository of repositories){
   const [owner,repo]=repository.split('/');
   const state=this.cursor.repos[repository],items=[];
   let sinceMs=Date.parse(state.since),querySince=state.scan?.since??new Date(sinceMs-GRACE_MS).toISOString();
   let page=state.scan?.page??1,latest=Date.parse(state.scan?.latest??state.since),complete=false;
   for(let checked=0;checked<MAX_PAGES;checked++){
    const response=await this.request('listCommentsForRepo',{owner,repo,sort:'updated',direction:'asc',per_page:PAGE_SIZE,page,since:querySince},{signal});
    requireValue(current(),'STALE_PLATFORM_SOURCE');
    const limit=githubRateLimitWait(response,this.now());
    if(response.status!==200){if(isRateLimited(response)){this.failureReason='GITHUB_RATE_LIMITED';return {waitMs:limit};}throw httpError(response);}
    requireValue(Array.isArray(response.body),'PLATFORM_INVALID_JSON');waitMs=Math.max(waitMs,limit);
    const serverTime=Date.parse(response.headers?.date);
    if(state.seedPending){
     delete state.seedPending;
     if(Number.isFinite(serverTime)&&serverTime!==sinceMs){
      // The first authenticated server clock owns the activation boundary.
      state.since=state.startedAt=new Date(serverTime).toISOString();sinceMs=latest=serverTime;
      await this.checkpoint?.save?.(JSON.stringify(this.cursor));requireValue(current(),'STALE_PLATFORM_SOURCE');
      querySince=new Date(sinceMs-GRACE_MS).toISOString();page=1;if(limit>0)break;continue;
     }
    }else if(Number.isFinite(serverTime))requireValue(sinceMs<=serverTime+GRACE_MS,'GITHUB_CHECKPOINT_FAILED','reconcile_original');
    items.push(...response.body);
    page++;complete=response.body.length<PAGE_SIZE;
    if(complete||limit>0)break;
   }
   const seen=new Set(state.seen.map(([id])=>id));
   // A bounded cache only avoids redundant transport work. ID order cannot
   // prove an unseen comment was read from mutable offset pages; Inbox owns deduplication.
   const createdAfter=Math.max(sinceMs-GRACE_MS,Date.parse(state.startedAt));
   const candidates=items.filter(comment=>Number.isSafeInteger(comment?.id)&&!seen.has(comment.id)&&Date.parse(comment.created_at)>=createdAfter).sort((a,b)=>a.id-b.id);
   for(const comment of candidates){
    const event=githubEvent(this.configuration,repository,comment);
    // Persist before the checkpoint moves: a crash replays into Inbox deduplication.
    if(event)await ingest(event);requireValue(current(),'STALE_PLATFORM_SOURCE');
    state.seen.push([comment.id,Math.floor(Date.parse(comment.created_at)/1000)]);seen.add(comment.id);
   }
   latest=items.reduce((max,comment)=>{const value=Date.parse(comment?.updated_at);return Number.isFinite(value)&&value>max?value:max;},latest);
   state.seen=state.seen.filter(([,created])=>created*1000>=latest-GRACE_MS).sort((a,b)=>a[0]-b[0]);
   if(state.seen.length>SEEN_LIMIT)state.seen.splice(0,state.seen.length-SEEN_LIMIT);
   // Hold the watermark until every page of this query is drained.
   // A same-second group may be larger than one bounded polling pass.
   if(complete){state.since=new Date(latest).toISOString();delete state.scan;}
   else state.scan={since:querySince,page,latest:new Date(latest).toISOString(),floor:0};
   requireValue(current(),'STALE_PLATFORM_SOURCE');
   await this.checkpoint?.save?.(JSON.stringify(this.cursor));requireValue(current(),'STALE_PLATFORM_SOURCE');
  }
  return {waitMs};
 }
 async poll(ingest,controller=this.controller,generation=this.generation,initialWait=0){
  const current=()=>generation===this.generation&&!controller.signal.aborted;
  let failures=0,waitMs=initialWait;
  while(current()){
   this.lastWaitMs=Math.max(waitMs,this.settings().pollIntervalMs);
   await this.wait(this.lastWaitMs,controller.signal).catch(()=>{});
   if(!current())return;
   try{({waitMs}=await this.pollOnce(ingest,current,controller.signal));failures=0;if(!waitMs)this.failureReason=null;}
   catch(error){
    if(!current())return;
    this.failureReason=connectionReasons.has(error?.code)?error.code:'GITHUB_POLL_FAILED';
    if(error?.code==='PLATFORM_AUTHORIZATION_FAILED'){this.observe('authorization_required');return;}
    if(error?.code==='GITHUB_REPOSITORY_UNAVAILABLE'){this.observe('failed');return;}
    if(++failures>=3){this.observe('degraded');return;}
    waitMs=Math.min(1000*2**failures,30000);
   }
  }
 }
 async reconnect({signal}={}){const ingest=this.ingest;requireValue(ingest&&this.state==='degraded','CHANNEL_STOPPED');this.generation++;this.controller?.abort();await this.loop?.catch(()=>{});this.loop=null;try{return await this.start(ingest,{signal});}catch(error){if(error?.code==='PLATFORM_AUTHORIZATION_FAILED')throw new ChannelError('AUTHORIZATION_REQUIRED','request_authorization');throw error;}}
 async stop(){this.generation++;this.unlinkSignal?.();this.unlinkSignal=null;this.controller?.abort();this.observe('stopped');await this.loop?.catch(()=>{});this.loop=null;}
 target(destination){return githubTarget(this.configuration,destination);}
 validateDestination(destination){this.target(destination);}
 /** Look for this delivery's marker among the bot's own recent comments on the issue. */
 async findDelivered({repository,number},deliveryId,signal){
  const marker=githubDeliveryMarker(deliveryId),bot=this.settings().botLogin.toLowerCase();
  const [owner,repo]=repository.split('/');
  const read=async page=>{
   signal?.throwIfAborted();
   const response=await this.request('listComments',{owner,repo,issue_number:Number(number),per_page:RECONCILE_PAGE_SIZE,page},{signal});
   if(response.status!==200)throw httpError(response);
   requireValue(Array.isArray(response.body),'PLATFORM_INVALID_JSON');return response;
  };
  const match=comments=>comments.find(comment=>String(comment?.user?.login??'').toLowerCase()===bot&&typeof comment.body==='string'&&comment.body.includes(marker));
  const first=await read(1);let last=1;
  for(const entry of String(first.headers?.link??'').split(',')){
   const match=/^\s*<([^>]+)>\s*;(.*)$/.exec(entry);
   const relation=match&&/(?:^|;)\s*rel\s*=\s*"([^"]*)"/.exec(match[2]);
   if(!relation?.[1].split(/\s+/).includes('last'))continue;
   try{
    const page=new URL(match[1]).searchParams.get('page');
    if(/^[1-9]\d*$/.test(page??'')&&Number.isSafeInteger(Number(page)))last=Number(page);
   }catch{ /* An invalid optional pagination hint cannot redirect a request. */ }
  }
  // Recent comments live on the last pages; the scan stays bounded.
  for(let page=last,checked=0;page>=1&&checked<RECONCILE_PAGES;page--,checked++){
   const found=match((page===1?first:await read(page)).body);
   if(found)return found;
  }
  return null;
 }
 async send(payload,{deliveryId,signal}={}){
  const target=this.target(payload.destination),marker=githubDeliveryMarker(deliveryId);
  const body=boundedText(String(payload.content?.text??''),60000)+'\n\n'+marker;
  const [owner,repo]=target.repository.split('/');
  signal?.throwIfAborted();
  this.headers();let response;
  try{response=await this.request('createComment',{owner,repo,issue_number:Number(target.number),body},{signal,maxBytes:1024*1024});}
  catch(error){response=null;if(error?.code==='UNSAFE_URL'||error?.code==='UNAPPROVED_HOST')throw error;}
  if(response?.status===201&&Number.isSafeInteger(response.body?.id))return {state:'accepted',messageId:String(response.body.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId};
  if(response&&response.status>=400&&response.status<500){const error=httpError(response,'GITHUB_COMMENT_REJECTED');return {state:'failed',code:error.code,httpStatus:response.status};}
  // Lost or ambiguous response: the comment may exist. Reconcile by marker
  // before anything else; absence right now is not proof it was not created.
  let found=null;
  if(!signal?.aborted){
   const reconcileSignal=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]);
   try{found=await this.findDelivered(target,deliveryId,reconcileSignal);}catch{found=null;}
  }
  if(found)return {state:'accepted',messageId:String(found.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId,reconciled:true};
  throw new ChannelError('GITHUB_DELIVERY_UNCONFIRMED','reconcile_original');
 }
 /** Explicit reconciliation of an unknown delivery. Never posts. */
 async reconcile(receipt,payload,{deliveryId,signal}={}){
  const found=await this.findDelivered(this.target(payload.destination),deliveryId,signal??AbortSignal.timeout(30000));
  return found?{state:'accepted',messageId:String(found.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId,reconciled:true}:{state:'unknown',code:'GITHUB_DELIVERY_MARKER_NOT_FOUND',recovery:'reconcile_original'};
 }
}
