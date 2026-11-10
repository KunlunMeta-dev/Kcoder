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
  if(!error.response)throw error.cause??error;
  response=error.response;
 }
 return {status:response.status,headers:{remaining:response.headers['x-ratelimit-remaining'],reset:response.headers['x-ratelimit-reset'],retryAfter:response.headers['retry-after'],link:response.headers.link},body:response.data};
}
/** Milliseconds to wait before the next request, or 0. Never spins on a limited token. */
export function githubRateLimitWait(response,now=Date.now()){
 const {status,headers={}}=response,remaining=headers.remaining==null?null:Number(headers.remaining);
 const clamp=value=>Math.min(MAX_WAIT_MS,Math.max(MIN_WAIT_MS,value));
 const retryAfter=headers.retryAfter==null?NaN:Number(headers.retryAfter)*1000;
 const untilReset=headers.reset==null?NaN:Number(headers.reset)*1000-now;
 const limited=status===429||status===403&&(remaining===0||Number.isFinite(retryAfter));
 if(limited)return clamp(Number.isFinite(retryAfter)?retryAfter:Number.isFinite(untilReset)?untilReset:60000);
 if(remaining!==null&&remaining<=1&&Number.isFinite(untilReset))return clamp(untilReset);
 return 0;
}
function httpError(response,fallback='PLATFORM_HTTP_REJECTED'){
 const status=response.status;
 const code=githubRateLimitWait(response)>0&&(status===429||status===403)?'GITHUB_RATE_LIMITED':status===401||status===403?'PLATFORM_AUTHORIZATION_FAILED':status===404||status===410?'GITHUB_REPOSITORY_UNAVAILABLE':fallback;
 const error=new ChannelError(code,code==='PLATFORM_AUTHORIZATION_FAILED'?'request_authorization':'repair_configuration');
 // Only a definite 4xx rejection proves no effect; server errors stay uncertain.
 error.externalOutcome=status>=400&&status<500?'failed':'unknown';error.httpStatus=status;return error;
}
function parseCursor(raw,repositories,now){
 let saved={};
 if(raw){try{saved=JSON.parse(raw);}catch{throw new ChannelError('GITHUB_CHECKPOINT_FAILED','reconcile_original');}}
 requireValue(saved&&typeof saved==='object'&&(saved.v===undefined||saved.v===1),'GITHUB_CHECKPOINT_FAILED','reconcile_original');
 const repos={};
 for(const repository of repositories){
  const value=saved.repos?.[repository];
  // A newly configured repository starts at "now": history is never replayed.
  if(!value){repos[repository]={since:new Date(now).toISOString(),floor:0,seen:[]};continue;}
  requireValue(typeof value.since==='string'&&Number.isFinite(Date.parse(value.since))&&Number.isSafeInteger(value.floor)&&Array.isArray(value.seen)&&value.seen.every(entry=>Array.isArray(entry)&&entry.length===2&&entry.every(Number.isSafeInteger)),'GITHUB_CHECKPOINT_FAILED','reconcile_original');
  repos[repository]={since:value.since,floor:value.floor,seen:value.seen.map(entry=>[...entry])};
 }
 return {v:1,repos};
}
export class GithubAdapter {
 constructor({configuration,credentials,transport=githubRequest,checkpoint,now=()=>Date.now(),wait=(ms,signal)=>sleep(ms,undefined,{signal})}){
  this.configuration=configuration;this.credentials=credentials;this.http=transport;this.checkpoint=checkpoint;this.now=now;this.wait=wait;
  this.state='stopped';this.generation=0;this.controller=null;this.loop=null;this.ingest=null;this.connectionObserver=null;this.failureReason=null;this.cursor=null;this.lastWaitMs=0;
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
  this.ingest=ingest;const generation=++this.generation,controller=new AbortController();this.controller=controller;
  const current=()=>generation===this.generation&&!controller.signal.aborted&&!signal?.aborted;
  this.failureReason=null;this.observe('starting');
  try{
   this.cursor=parseCursor(await this.checkpoint?.load?.()??'',settings.repositories,this.now());requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   // Persist the starting watermark before any read so a restart cannot skip.
   await this.checkpoint?.save?.(JSON.stringify(this.cursor));requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   const first=await this.pollOnce(ingest,current,AbortSignal.any([controller.signal,...(signal?[signal]:[])]));requireValue(current(),'GITHUB_CONNECTION_CANCELLED');
   this.observe('connected');this.loop=this.poll(ingest,controller,generation,first.waitMs);
  }catch(error){
   if(generation===this.generation&&!controller.signal.aborted){this.failureReason=connectionReasons.has(error?.code)?error.code:'GITHUB_POLL_FAILED';this.observe(error?.code==='PLATFORM_AUTHORIZATION_FAILED'?'authorization_required':error?.code==='GITHUB_REPOSITORY_UNAVAILABLE'?'failed':'degraded');}
   throw error;
  }
 }
 /** One bounded pass over every configured repository. Returns the next backoff. */
 async pollOnce(ingest,current,signal){
  const {repositories}=this.settings();let waitMs=0;
  for(const repository of repositories){
   const [owner,repo]=repository.split('/');
   const state=this.cursor.repos[repository],sinceMs=Date.parse(state.since),items=[];
   for(let page=1;page<=MAX_PAGES;page++){
    const response=await this.request('listCommentsForRepo',{owner,repo,sort:'updated',direction:'asc',per_page:PAGE_SIZE,page,since:state.since},{signal});
    requireValue(current(),'STALE_PLATFORM_SOURCE');
    const limit=githubRateLimitWait(response,this.now());
    if(response.status!==200){if(limit>0){this.failureReason='GITHUB_RATE_LIMITED';return {waitMs:limit};}throw httpError(response);}
    requireValue(Array.isArray(response.body),'PLATFORM_INVALID_JSON');
    items.push(...response.body);waitMs=Math.max(waitMs,limit);
    if(response.body.length<PAGE_SIZE||limit>0)break;
   }
   const seen=new Set(state.seen.map(([id])=>id));
   // Ids are assigned at creation: processing in id order keeps the floor
   // monotonic. Edits of older comments fall outside the grace window.
   const candidates=items.filter(comment=>Number.isSafeInteger(comment?.id)&&comment.id>state.floor&&!seen.has(comment.id)&&Date.parse(comment.created_at)>=sinceMs-GRACE_MS).sort((a,b)=>a.id-b.id);
   for(const comment of candidates){
    let event=null;
    try{event=githubEvent(this.configuration,repository,comment);}catch{event=null;}
    // Persist before the checkpoint moves: a crash replays into Inbox deduplication.
    if(event)await ingest(event);requireValue(current(),'STALE_PLATFORM_SOURCE');
    state.seen.push([comment.id,Math.floor(Date.parse(comment.created_at)/1000)]);seen.add(comment.id);
   }
   const latest=items.reduce((max,comment)=>{const value=Date.parse(comment?.updated_at);return Number.isFinite(value)&&value>max?value:max;},sinceMs);
   state.since=new Date(latest).toISOString();
   state.seen=state.seen.filter(([,created])=>created*1000>=latest-GRACE_MS).sort((a,b)=>a[0]-b[0]);
   if(state.seen.length>SEEN_LIMIT){const dropped=state.seen.splice(0,state.seen.length-SEEN_LIMIT);state.floor=Math.max(state.floor,dropped.at(-1)[0]);}
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
 async stop(){this.generation++;this.controller?.abort();this.observe('stopped');await this.loop?.catch(()=>{});this.loop=null;}
 target(destination){return githubTarget(this.configuration,destination);}
 validateDestination(destination){this.target(destination);}
 /** Look for this delivery's marker among the bot's own recent comments on the issue. */
 async findDelivered({repository,number},deliveryId,signal){
  const marker=githubDeliveryMarker(deliveryId),bot=this.settings().botLogin.toLowerCase();
  const [owner,repo]=repository.split('/');
  const read=async page=>{
   const response=await this.request('listComments',{owner,repo,issue_number:Number(number),per_page:RECONCILE_PAGE_SIZE,page},{signal});
   if(response.status!==200)throw httpError(response);
   requireValue(Array.isArray(response.body),'PLATFORM_INVALID_JSON');return response;
  };
  const match=comments=>comments.find(comment=>String(comment?.user?.login??'').toLowerCase()===bot&&typeof comment.body==='string'&&comment.body.includes(marker));
  const first=await read(1),last=Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(first.headers?.link??'')?.[1]??1);
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
  this.headers();let response;
  try{response=await this.request('createComment',{owner,repo,issue_number:Number(target.number),body},{signal,maxBytes:1024*1024});}
  catch(error){response=null;if(error?.code==='UNSAFE_URL'||error?.code==='UNAPPROVED_HOST')throw error;}
  if(response?.status===201&&Number.isSafeInteger(response.body?.id))return {state:'accepted',messageId:String(response.body.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId};
  if(response&&response.status>=400&&response.status<500){const error=httpError(response,'GITHUB_COMMENT_REJECTED');return {state:'failed',code:error.code,httpStatus:response.status};}
  // Lost or ambiguous response: the comment may exist. Reconcile by marker
  // before anything else; absence right now is not proof it was not created.
  let found=null;
  try{found=await this.findDelivered(target,deliveryId,AbortSignal.timeout(15000));}catch{found=null;}
  if(found)return {state:'accepted',messageId:String(found.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId,reconciled:true};
  throw new ChannelError('GITHUB_DELIVERY_UNCONFIRMED','reconcile_original');
 }
 /** Explicit reconciliation of an unknown delivery. Never posts. */
 async reconcile(receipt,payload,{deliveryId,signal}={}){
  const found=await this.findDelivered(this.target(payload.destination),deliveryId,signal??AbortSignal.timeout(30000));
  return found?{state:'accepted',messageId:String(found.id),receiptKind:'github_issue_comment',clientRequestId:deliveryId,reconciled:true}:{state:'unknown',code:'GITHUB_DELIVERY_MARKER_NOT_FOUND',recovery:'reconcile_original'};
 }
}
