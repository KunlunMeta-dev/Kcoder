import { identifier, scopeKey } from '../validation.mjs';
import { requireValue } from '../errors.mjs';
const KIND='application_authorization_cleanup';
const equalRef=(a,b)=>a&&b&&a.id===b.id&&a.revision===b.revision;
function project(row){
  return {operationId:row.operationId,connectionRef:{...row.connectionRef},localRemoval:row.localRemoval,availability:row.availability,providerRevocationRequested:false};
}
export function readLocalAuthorizationCleanup(service,scope,query){
  identifier(query.operationId);identifier(query.connectionRef?.id);identifier(query.connectionRef?.revision);
  const row=service.store.readEntity(KIND,scope,query.operationId);
  if(!row)return null;
  requireValue(row.executionScope===scopeKey(scope)&&row.operationId===query.operationId&&equalRef(row.connectionRef,query.connectionRef),'APPLICATION_ORIGINAL_CLEANUP_CHANGED','reconcile_original');
  return project(row);
}
export function beginLocalAuthorizationCleanup(service,request,connection){
  const existing=service.store.readEntity(KIND,request.scope,request.operationId);
  requireValue(!existing,'APPLICATION_ORIGINAL_CLEANUP_CHANGED','reconcile_original');
  return service.store.putEntity(KIND,request.scope,request.operationId,{executionScope:scopeKey(request.scope),operationId:request.operationId,connectionRef:{id:connection.id,revision:connection.revision},localRemoval:'unknown',availability:'unknown'},null);
}
export function updateLocalAuthorizationCleanup(service,scope,row,fields){
  const next=service.store.putEntity(KIND,scope,row.operationId,{...row,...fields},row.revision);
  return {row:next,receipt:project(next)};
}
