import { randomUUID } from 'node:crypto';
import { ChannelError, requireValue, publicError } from '../errors.mjs';
import { APPLICATION_CATALOG, catalogEntry, validateApplicationConfiguration } from '../catalog.mjs';
import { identifier, privatePayload, scopeKey, stableId, digest } from '../validation.mjs';
import { PORTS, MUTATIONS, validateRequest, reply, rejected, CONTRACT_VERSION } from './wire.mjs';
import { validateNativeReply, policyDecision, runtimeAcceptance } from './native-results.mjs';
import { connectivitySettings } from './settings.mjs';
import { validateMethodPayload } from './method-payloads.mjs';
import { taskSourceCatalog } from './task-sources.mjs';
import { beginLocalAuthorizationCleanup, updateLocalAuthorizationCleanup, readLocalAuthorizationCleanup } from './authorization-cleanup.mjs';
const isApplication = kind => APPLICATION_CATALOG.some(entry => entry.kind === kind);
function exactToolRef(tool) { return tool && typeof tool.name === 'string' && tool.name.length > 0 && typeof tool.schemaRevision === 'string' && tool.schemaRevision.length > 0 && typeof tool.sourceRevision === 'string' && tool.sourceRevision.length > 0; }

/** Application/MCP management only. Platform channel workers belong to the Gateway. */
export class ApplicationService {
 constructor({store,ports,inventory,verifiers=new Map(),applications,settings,now=()=>Date.now()}) {
  requireValue(store && typeof ports?.call === 'function','APPLICATION_PORTS_REQUIRED');
  Object.assign(this,{store,ports,inventory,verifiers,applications,now});
  this.settings=connectivitySettings(settings);this.readinessReports=new Map();
 }
 request(scope, payload, operationId) {
    return { contractVersion: CONTRACT_VERSION, requestId: randomUUID(), scope, timeoutMs: 30000, payload, ...(operationId ? { operationId } : {}) };
  }
 async nativeCall(port,method,request) { return validateNativeReply(request,await this.ports.call(port,method,request)); }
 async authorize(scope, action, resource, operationId) {
    const result = await this.nativeCall('P-POLICY', 'evaluateAction', this.request(scope, { action, resource }, operationId));
    requireValue(result?.status === 'completed' && policyDecision(result.result) === 'allow', 'RESOURCE_DENIED', 'request_authorization');
    return result.result;
  }
 async call(port,method,request) {
  let ownOperation=false;
  try {
   requireValue(PORTS[port]?.includes(method),'METHOD_UNSUPPORTED','repair_configuration');
   validateRequest(request,method);validateMethodPayload(method,request.payload);
   if(method==='listConnections')requireValue(request.payload.category===undefined||request.payload.category==='applications','METHOD_UNSUPPORTED');
   if(method==='prepareConnectionAction'&&request.payload.action==='save')requireValue(isApplication(request.payload.kind),'APPLICATION_UNSUPPORTED');
   const connection=request.payload.connectionId&&this.store.readEntity('connection',request.scope,request.payload.connectionId);
   if(connection)requireValue(isApplication(connection.kind),'APPLICATION_UNSUPPORTED');
   await this.authorize(request.scope,'connectivity.'+method,{port,payload:request.payload},request.operationId);
   if(MUTATIONS.has(method)) {
    const operation=this.store.beginOperation(request.scope,request.operationId,method,{payload:request.payload,expectedRevision:request.expectedRevision??null});
    if(!operation.fresh){if(operation.state==='rejected'&&operation.result?.error)return reply(request,operation.result.status??'rejected',null,operation.result.error);if(operation.result)return reply(request,'completed',operation.result);throw new ChannelError('OPERATION_UNCONFIRMED','reconcile_original');}
   }
   ownOperation=MUTATIONS.has(method);
   const result=method==='readConnection'&&request.payload.localCleanupReceipt?this.readLocalAuthorizationCleanup(request):await this[method](request);
   if(ownOperation)this.store.finishOperation(request.scope,request.operationId,result);
   return reply(request,'completed',result,null,result?.revision??null);
  }catch(error){
   if(ownOperation&&error?.operationNotStarted===true){const safe={...publicError(error),recovery:'retry_read'};try{this.store.finishOperation(request.scope,request.operationId,{status:'rejected',error:safe},'rejected');return reply(request,'rejected',null,safe);}catch{return reply(request,'unknown',null,{...safe,recovery:'reconcile_original'});}}
   return rejected(request,error);
  }
 }
 async listConnections(request) {
  const page=this.store.listEntities('connection',request.scope,{...request.payload,kinds:APPLICATION_CATALOG.map(entry=>entry.kind)});
  const items=await Promise.all(page.items.map(connection=>this.observedConnection(request.scope,connection)));
  let sources=[],sourcesState='unknown';
  if(this.applications?.listSources){try{const result=await this.applications.listSources(request.scope);sources=result.items;sourcesState=result.truncated?'truncated':'observed';}catch{}}
  let taskSources=taskSourceCatalog(null);try{taskSources=taskSourceCatalog(await this.inventory?.(request.scope));}catch{}
  return {catalog:{applications:APPLICATION_CATALOG},...page,items,sources,sourcesState,...taskSources};
 }
 async readConnection(request) {
  const connection=this.store.readEntity('connection',request.scope,request.payload.connectionId);
  requireValue(connection&&isApplication(connection.kind),'CONNECTION_NOT_FOUND');
  return this.observedConnection(request.scope,connection);
 }
 readLocalAuthorizationCleanup(request){
    const connection=this.store.readEntity('connection',request.scope,request.payload.connectionId);
    requireValue(connection,'CONNECTION_NOT_FOUND');

      const query=request.payload.localCleanupReceipt;
      requireValue(query.connectionRef.id===connection.id,'APPLICATION_ORIGINAL_CLEANUP_CHANGED','reconcile_original');
      const receipt=readLocalAuthorizationCleanup(this,request.scope,query);
      // This reads original metadata only. It does not infer current authorization
      // from saved connection data or wait on a potentially busy Native provider.
      return {...connection,hasCredential:false,enabled:false,state:'degraded',connectionObservationState:'unknown',localAuthorizationCleanup:receipt,localAuthorizationCleanupObservation:receipt?'observed':'unknown'};
  }
 async observedConnection(scope,connection) {
  const view=this.connectionView(scope,connection);
  if(this.applications?.read){try{const status=await this.applications.read(scope,connection);return {...view,hasCredential:['authorized','configuredHeader','notApplicable'].includes(status.authorization),enabled:view.enabled&&status.enabled,state:!['authorized','configuredHeader','notApplicable'].includes(status.authorization)?'authorization_required':view.enabled&&status.enabled?'configured':'stopped'};}catch{return {...view,hasCredential:false,enabled:false,state:'degraded'};}}
  return view;
 }
 connectionView(scope,connection) {
  const fence=this.store.readEntity('connection_fence',scope,connection.id),current=fence?.identityGeneration===scope.identityGeneration&&fence?.targetRevision===scope.targetRevision;
  return {...connection,hasCredential:current&&connection.hasCredential,enabled:current&&connection.enabled,state:!current&&connection.hasCredential?'authorization_required':connection.state};
 }
async readResourceGrant(request) {
    const connection = await this.readConnection(request);
    if(request.payload.discover===true && APPLICATION_CATALOG.some(value=>value.kind===connection.kind)){
      requireValue(typeof this.applications?.listResources==='function','APPLICATION_PROVIDER_UNAVAILABLE','repair_configuration');
      const page=await this.applications.listResources(request.scope,connection,request.payload);
      requireValue(Array.isArray(page?.items)&&page.items.length<=10,'APPLICATION_RESOURCE_RECEIPT_INVALID');
      const items=page.items.map(resource=>{
        requireValue(typeof resource.id==='string'&&typeof resource.revision==='string'&&catalogEntry(connection.kind).resourceKinds.includes(resource.kind),'APPLICATION_RESOURCE_RECEIPT_INVALID');
        const id=stableId('application-resource',[connection.id,resource.kind,resource.id]);
        const old=this.store.readEntity('resource_candidate',request.scope,id);
        const value={connectionId:connection.id,kind:resource.kind,label:String(resource.label??resource.id),nativeResourceRef:{id:resource.id,revision:resource.revision,kind:resource.kind},sourceIdentity:{name:connection.configuration.mcpServerName,pluginId:connection.configuration.pluginId??null}};
        const previous=old?Object.fromEntries(Object.entries(old).filter(([key])=>!['id','revision'].includes(key))):null;
        const candidate=old&&digest(previous)===digest(value)?old:this.store.putEntity('resource_candidate',request.scope,id,value,old?.revision??null);
        return {id:candidate.id,revision:candidate.revision,kind:candidate.kind,label:candidate.label};
      });
      return {connectionId:connection.id,revision:connection.revision,resourceGrants:connection.resourceGrants??[],items,nextCursor:page.nextCursor??null};
    }
    return {connectionId:connection.id,revision:connection.revision,resourceGrants:connection.resourceGrants??[],items:[],nextCursor:null};
  }
 async prepareConnectionAction(request) {
  const {action,connectionId}=request.payload;identifier(connectionId);
  if(action==='save') {
   const {kind,label,configuration={},resourceGrants=[]}=request.payload;
   requireValue(isApplication(kind),'APPLICATION_UNSUPPORTED');validateApplicationConfiguration(configuration);
   requireValue(typeof label==='string'&&label.length<=160&&Array.isArray(resourceGrants)&&resourceGrants.length===0,'INVALID_CONNECTION');
   requireValue(request.payload.credentialBinding===undefined,'APPLICATION_CREDENTIAL_REFERENCE_UNSUPPORTED');
   privatePayload(configuration);privatePayload(resourceGrants);
   return this.store.transaction(()=>{
    const connection=this.store.putEntityInTransaction('connection',request.scope,connectionId,{kind,label,configuration,resourceGrants,enabled:false,hasCredential:false,state:'authorization_required'},request.expectedRevision??null);
    const old=this.store.readEntity('connection_fence',request.scope,connectionId);
    this.store.putEntityInTransaction('connection_fence',request.scope,connectionId,{identityGeneration:request.scope.identityGeneration,targetRevision:request.scope.targetRevision},old?.revision??null);
    return connection;
   });
  }
  const connection=await this.readConnection(request);requireValue(String(request.expectedRevision)===connection.revision,'REVISION_CONFLICT','repair_configuration');
  if(['authorize','cancelAuthorization','start','enable','stop','disable','disconnect'].includes(action)) {
   requireValue(this.applications,'APPLICATION_PROVIDER_UNAVAILABLE','repair_configuration');
   if(action==='authorize')return {connectionId,...await this.applications.authorize(request.scope,connection,request.operationId)};
   if(action==='cancelAuthorization')return this.applications.cancelAuthorization(request.scope,connection,request.payload.authorizationId,request.payload.authorizationOperationId);
   let cleanup;
   if(action==='disconnect'){cleanup=beginLocalAuthorizationCleanup(this,request,connection);const removed=await this.applications.disconnect(request.scope,connection);requireValue(removed?.loggedOut===true,'APPLICATION_LOGOUT_UNCONFIRMED','reconcile_original');cleanup=updateLocalAuthorizationCleanup(this,request.scope,cleanup,{localRemoval:'accepted'}).row;}
   const enabled=['start','enable'].includes(action),result=await this.applications.setEnabled(request.scope,connection,enabled),status=await this.applications.read(request.scope,connection);
   const updated=this.store.putEntity('connection',request.scope,connectionId,{...connection,enabled,hasCredential:['authorized','configuredHeader','notApplicable'].includes(status.authorization),state:enabled?'configured':'stopped',configuration:{...connection.configuration,appliesToNewConversations:result.appliesToNewConversations}},connection.revision);
   return cleanup?{...updated,localAuthorizationCleanup:updateLocalAuthorizationCleanup(this,request.scope,cleanup,{availability:'disabled'}).receipt,localAuthorizationCleanupObservation:'observed'}:updated;
  }
  if(action==='runOfficeTask')return this.runOfficeTask(request,connection);
  if(action==='setResources') {
   const grants=request.payload.resourceGrants;requireValue(Array.isArray(grants)&&grants.length<=100,'INVALID_RESOURCES');
   for(const ref of grants){const candidate=this.store.readEntity('resource_candidate',request.scope,ref.id);requireValue(candidate&&candidate.connectionId===connection.id&&candidate.revision===ref.revision&&candidate.kind===ref.kind,'APPLICATION_RESOURCE_CHANGED','request_authorization');}
   await this.authorize(request.scope,'application.selectResources',{connectionId:connection.id,resourceRefs:grants},request.operationId);
   return this.store.putEntity('connection',request.scope,connectionId,{...connection,resourceGrants:grants},connection.revision);
  }
  throw new ChannelError('CONNECTION_ACTION_UNSUPPORTED');
 }
async runOfficeTask(request,connection){
    requireValue(this.settings.enabled,'CONNECTIVITY_DISABLED','repair_configuration');
    requireValue(connection.enabled,'APPLICATION_DISABLED','repair_configuration');
    const {businessAction,resourceRefs,taskText,attachments=[]}=request.payload;
    const actions={tencent_docs:['document.summarize','document.create','document.compare'],agent_mail:['mail.summarize','mail.draft','mail.send'],feishu_bitable:['table.analyze','table.query','table.export']};
    requireValue(actions[connection.kind]?.includes(businessAction)&&typeof taskText==='string'&&taskText.trim().length>0&&taskText.length<=65536,'INVALID_APPLICATION_TASK');
    requireValue(Array.isArray(resourceRefs)&&resourceRefs.length>0&&resourceRefs.length<=100,'APPLICATION_RESOURCE_SELECTION_REQUIRED');
    for(const ref of resourceRefs){
      const candidate=this.store.readEntity('resource_candidate',request.scope,ref.id);
      requireValue(candidate&&candidate.connectionId===connection.id&&candidate.revision===ref.revision&&candidate.kind===ref.kind&&(connection.resourceGrants??[]).some(grant=>grant.id===ref.id&&grant.revision===ref.revision),'APPLICATION_RESOURCE_CHANGED','request_authorization');
    }
    requireValue(Array.isArray(attachments)&&attachments.length<=20&&attachments.every(ref=>ref?.kind==='office_input'&&ref.status==='accepted'&&typeof ref.inputId==='string'&&ref.revision===1&&!ref.path&&!ref.stageRef),'APPLICATION_ATTACHMENT_INVALID');
    requireValue(attachments.every(ref=>ref.owner?.accountId===request.scope.accountId&&ref.owner?.targetId===request.scope.targetId&&ref.owner?.workspaceId===request.scope.workspaceId&&(ref.owner?.organizationId??null)===(request.scope.organizationId??null)),'NATIVE_ATTACHMENT_OWNER_MISMATCH');
    await this.authorize(request.scope,'application.runOfficeTask',{connectionId:connection.id,connectionRevision:connection.revision,businessAction,resourceRefs},request.operationId);
    const result=await this.nativeCall('P-RUNTIME','acceptTask',this.request(request.scope,{source:{kind:'application',applicationKind:connection.kind,connectionId:connection.id,resourceRefs},conversationKey:stableId('application-conversation',[connection.id,request.operationId]),message:{text:taskText,attachments}},request.operationId));
    requireValue(result.status==='accepted','APPLICATION_TASK_UNCONFIRMED','reconcile_original');
    runtimeAcceptance(result.result);
    return {...result.result,nativeOperationId:request.operationId};
  }
resolveApplicationConfiguration(scope,connectionId){
    this.store.assertOwnership();
    const connection=this.store.readEntity('connection',scope,connectionId);
    const fence=this.store.readEntity('connection_fence',scope,connectionId);
    requireValue(connection&&APPLICATION_CATALOG.some(value=>value.kind===connection.kind),'APPLICATION_SOURCE_UNAVAILABLE');
    validateApplicationConfiguration({mcpServerName:connection.configuration?.mcpServerName,pluginId:connection.configuration?.pluginId??null});
    requireValue(fence?.identityGeneration===scope.identityGeneration&&fence?.targetRevision===scope.targetRevision,'APPLICATION_SCOPE_CHANGED');
    // Metadata only. The native public owner separately authorizes every use.
    return {nativeNamespaceId:this.store.storage.binding.namespaceId,connectionId:connection.id,connectionRevision:connection.revision,
      kind:connection.kind,source:{server:connection.configuration.mcpServerName,plugin:connection.configuration.pluginId??null}};
  }
resolveApplicationResources(scope,connectionId,resourceRefs){
    const connection=this.store.readEntity('connection',scope,connectionId);
    requireValue(connection&&APPLICATION_CATALOG.some(value=>value.kind===connection.kind),'APPLICATION_SOURCE_UNAVAILABLE');
    requireValue(Array.isArray(resourceRefs)&&resourceRefs.length>0&&resourceRefs.length<=100,'INVALID_RESOURCES');
    const resources=resourceRefs.map(ref=>{
      const candidate=this.store.readEntity('resource_candidate',scope,ref.id);
      requireValue(candidate&&candidate.connectionId===connectionId&&candidate.revision===ref.revision&&candidate.kind===ref.kind&&(connection.resourceGrants??[]).some(grant=>grant.id===ref.id&&grant.revision===ref.revision),'APPLICATION_RESOURCE_CHANGED','request_authorization');
      return {reference:ref,sourceResourceRef:candidate.nativeResourceRef};
    });
    // This private locator does not authorize its resources; the native consumer rechecks grants.
    return {nativeNamespaceId:this.store.storage.binding.namespaceId,connectionId:connection.id,connectionRevision:connection.revision,applicationKind:connection.kind,source:{name:connection.configuration.mcpServerName,pluginId:connection.configuration.pluginId??null},resources};
  }
async resolveCapability(request) {
    const { capabilityId, connectionId } = request.payload; identifier(capabilityId);
    const connection = connectionId ? await this.readConnection(request) : null;
    const inventory = await this.inventory?.(request.scope);
    if (!inventory) return { state: 'unknown', reasonCode: 'NATIVE_INVENTORY_UNAVAILABLE', matches: [] };
    const matches = (inventory.tools ?? []).filter(t => exactToolRef(t) && t.registered === true && t.allowed === true && t.capabilities?.includes(capabilityId) && (!connectionId || t.connectionId === connectionId))
      .map(t => ({ name: t.name, schemaRevision: t.schemaRevision, sourceRevision: t.sourceRevision, availability: t.deferred ? 'discovered' : 'already_available' }));
    return { state: matches.length ? 'resolved' : 'unresolved', reasonCode: matches.length ? null : 'TOOL_NOT_AVAILABLE_FOR_REQUEST', connectionRevision: connection?.revision ?? null,requestRevision:inventory.requestRevision??null, matches };
  }
async inspectReadiness(request) {
    const connection = request.payload.connectionId ? await this.readConnection(request) : null;
    const inventory = await this.inventory?.(request.scope);
    const observedAt = new Date(this.now()).toISOString();
    const capabilityIds = request.payload.capabilityIds ?? [];
    requireValue(Array.isArray(capabilityIds) && capabilityIds.length <= 64 && capabilityIds.every(id => typeof id === 'string' && id.length > 0), 'INVALID_CAPABILITIES');
    const capabilities = [];
    for (const capabilityId of capabilityIds) {
      const tools = (inventory?.tools ?? []).filter(tool => exactToolRef(tool) && tool.registered === true && tool.allowed === true && tool.capabilities?.includes(capabilityId) && (!connection || tool.connectionId === connection.id));
      let state = !inventory?.requestRevision ? 'unknown' : !tools.length ? 'unavailable' : 'unknown';
      let reasonCode = !inventory?.requestRevision ? 'NATIVE_INVENTORY_UNAVAILABLE' : !tools.length ? 'TOOL_NOT_AVAILABLE_FOR_REQUEST' : 'RESOURCE_NOT_VERIFIED';
      let policyRevision;
      if(connection&&(!connection.enabled||!this.settings.enabled)){state='unavailable';reasonCode='CONNECTION_DISABLED';}
      else if (tools.length && inventory?.requestRevision) {
        const policy = await this.nativeCall('P-POLICY','evaluateAction',this.request(request.scope,{action:'capability.use',resource:{capabilityId,connectionId:connection?.id??null,resourceRefs:request.payload.resourceRefs??[],toolRefs:tools.map(tool=>({name:tool.name,schemaRevision:tool.schemaRevision,sourceRevision:tool.sourceRevision}))}}));
        if (policy.status==='completed') {
          const decision=policyDecision(policy.result);policyRevision=policy.result.policyRevision;
          if(decision==='deny'){state='denied';reasonCode=policy.result.reasonCode;}
          else if(decision==='allow'){
            const authorization=connection?(inventory.connections??[]).find(value=>value.id===connection.id):null;
            if(!connection || connection.hasCredential && authorization?.authorizationState==='valid' && authorization.connectionRevision===connection.revision){state='ready';reasonCode='CURRENT_ADMISSION_CHECKS_PASSED';}
            else reasonCode='CONNECTION_AUTHORIZATION_UNVERIFIED';
          }
        }
      }
      capabilities.push({capabilityId,state,reasonCode,toolRefs:tools.map(tool=>({name:tool.name,schemaRevision:tool.schemaRevision,sourceRevision:tool.sourceRevision})),...(policyRevision?{policyRevision}:{})});
    }
    const observations = [
      { level: 'L0', state: inventory ? 'observed' : 'unknown', reasonCode: inventory ? null : 'NATIVE_INVENTORY_UNAVAILABLE' },
      { level: 'L1', state: connection && (inventory?.components??[]).some(component=>component.kind===connection.kind&&component.installed===true&&typeof component.version==='string') ? 'observed' : 'unknown', reasonCode: 'INSTALLATION_OBSERVATION_ONLY' },
      { level: 'L2', state: connection ? 'observed' : 'unknown', reasonCode: connection ? null : 'CONNECTION_NOT_CONFIGURED' },
      { level: 'L3', state: 'unknown', reasonCode: 'AUTHORIZATION_NOT_BUSINESS_VERIFIED' },
      { level: 'L4', state: inventory ? 'observed' : 'unknown', reasonCode: null, ...(inventory?.tools ? {toolCount:inventory.tools.length} : {}) },
      { level: 'L5', state: inventory?.requestRevision ? 'observed' : 'unknown', reasonCode: null, ...(inventory?.requestRevision ? {requestRevision:inventory.requestRevision} : {}) },
      { level: 'L6', state: 'unknown', reasonCode: 'BUSINESS_CHECK_NOT_EXECUTED' },
    ];
    const report = { connectionId: connection?.id ?? null, connectionRevision: connection?.revision ?? null, targetRevision: request.scope.targetRevision, identityGeneration: request.scope.identityGeneration, requestRevision: inventory?.requestRevision ?? null, observedAt, observations, capabilities };
    const id = request.payload.connectionId ?? 'target';
    privatePayload(report);
    const key=scopeKey(request.scope)+':'+id;
    this.readinessReports.delete(key);
    while(this.readinessReports.size>=32)this.readinessReports.delete(this.readinessReports.keys().next().value);
    this.readinessReports.set(key,{report:structuredClone(report),resourceRefs:structuredClone(request.payload.resourceRefs??[]),expiresAt:this.now()+60000});
    return report;
  }
async readReadiness(request) {
    const entry=this.readinessReports.get(scopeKey(request.scope)+':'+(request.payload.connectionId??'target'));
    const report=entry?.report??this.store.readEntity('readiness', request.scope, request.payload.connectionId ?? 'target');
    if (!report) return { observations: [], capabilities: [], state: 'unobserved' };
    const connection=request.payload.connectionId?await this.readConnection(request):null;
    const inventory=await this.inventory?.(request.scope);
    let policyCurrent=true;
    for(const capability of report.capabilities??[])if(capability.policyRevision){
      try{const reply=await this.nativeCall('P-POLICY','evaluateAction',this.request(request.scope,{action:'capability.use',resource:{capabilityId:capability.capabilityId,connectionId:connection?.id??null,resourceRefs:entry?.resourceRefs??[],toolRefs:capability.toolRefs}}));
        policyCurrent&&=reply.status==='completed'&&policyDecision(reply.result)===(capability.state==='denied'?'deny':'allow')&&reply.result.policyRevision===capability.policyRevision;
      }catch{policyCurrent=false;}
    }
    if(!entry||entry.expiresAt<=this.now()||!policyCurrent||!inventory?.requestRevision || report.requestRevision!==inventory.requestRevision || report.identityGeneration!==request.scope.identityGeneration || report.targetRevision!==request.scope.targetRevision || connection && report.connectionRevision!==connection.revision) return {...report,state:'stale',observations:report.observations.map(value=>value.state==='observed'?{...value,state:'stale',reasonCode:'READINESS_STALE'}:value),capabilities:(report.capabilities??[]).map(value=>({...value,state:'unknown',reasonCode:'READINESS_STALE'}))};
    return structuredClone(report);
  }
async verifyCapability(request) {
    const capability = await this.resolveCapability(request);
    requireValue(capability.state === 'resolved', 'CAPABILITY_NOT_AVAILABLE');
    const verifier = this.verifiers.get(request.payload.capabilityId);
    requireValue(verifier && verifier.readOnly === true, 'BUSINESS_VERIFIER_UNAVAILABLE', 'repair_configuration');
    await this.authorize(request.scope, 'capability.verifyReadonly', { capabilityId: request.payload.capabilityId, matches: capability.matches }, request.operationId);
    return verifier.run({ scope: request.scope, matches: capability.matches,connectionId:request.payload.connectionId,resourceRefs:request.payload.resourceRefs??[],requestRevision:capability.requestRevision, operationId: request.operationId, signal: AbortSignal.timeout(request.timeoutMs) });
  }
 async close(){this.readinessReports.clear();}
}
