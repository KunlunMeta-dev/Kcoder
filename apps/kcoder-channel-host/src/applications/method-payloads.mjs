import { requireValue } from '../errors.mjs';
import { identifier } from '../validation.mjs';
import { APPLICATION_CATALOG,validateApplicationConfiguration } from '../catalog.mjs';
function keys(value,allowed,code){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key)),code);}
function ref(value){keys(value,['id','revision'],'INVALID_DESTINATION_REFERENCE');identifier(value.id);identifier(value.revision);}
export function validateMethodPayload(method,payload){
  if(method==='prepareConnectionAction')requireValue(['save','authorize','cancelAuthorization','start','enable','stop','disable','disconnect','runOfficeTask','setResources'].includes(payload.action),'CONNECTION_ACTION_UNSUPPORTED','repair_configuration');
  if(method==='readConnection'&&payload.localCleanupReceipt!==undefined){keys(payload,['connectionId','localCleanupReceipt'],'INVALID_LOCAL_CLEANUP_QUERY');identifier(payload.connectionId);keys(payload.localCleanupReceipt,['operationId','connectionRef'],'INVALID_LOCAL_CLEANUP_QUERY');identifier(payload.localCleanupReceipt.operationId);ref(payload.localCleanupReceipt.connectionRef);}

  if(method==='prepareConnectionAction'&&payload.action==='save'&&APPLICATION_CATALOG.some(value=>value.kind===payload.kind))validateApplicationConfiguration(payload.configuration??{});
  if(method==='inspectReadiness'){
    keys(payload,['capabilityIds','connectionId','resourceRefs'],'INVALID_READINESS_FIELD');
    requireValue(payload.capabilityIds===undefined||Array.isArray(payload.capabilityIds)&&payload.capabilityIds.length<=64,'INVALID_CAPABILITIES');
    for(const capability of payload.capabilityIds??[])identifier(capability);
    if(payload.connectionId!=null)identifier(payload.connectionId);
    requireValue(payload.resourceRefs===undefined||Array.isArray(payload.resourceRefs)&&payload.resourceRefs.length<=100,'INVALID_RESOURCES');
  }
}
