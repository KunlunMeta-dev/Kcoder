import { requireValue } from '../errors.mjs';
import { identifier } from '../validation.mjs';
const fields=['sourceRef','accountRef','kind','displayName','accountDisplayName','state','reasonCode','capabilities'];
function reference(value){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&Object.keys(value).every(key=>['id','revision'].includes(key)),'TASK_CAPABILITY_SOURCE_REFERENCE_INVALID');identifier(value.id);identifier(value.revision);return {id:value.id,revision:value.revision};}
export function taskCapabilitySourceDescriptor(value){
 requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key)),'TASK_CAPABILITY_SOURCE_DESCRIPTOR_INVALID');
 const sourceRef=reference(value.sourceRef),accountRef=value.accountRef===null?null:reference(value.accountRef);
 requireValue(['mcp','plugin_mcp','application'].includes(value.kind)&&['ready','unavailable','unauthorized','unknown'].includes(value.state),'TASK_CAPABILITY_SOURCE_DESCRIPTOR_INVALID');
 identifier(value.displayName);if(value.accountDisplayName!==null)identifier(value.accountDisplayName);if(value.reasonCode!==null)identifier(value.reasonCode);
 requireValue(Array.isArray(value.capabilities)&&value.capabilities.length<=3&&new Set(value.capabilities).size===value.capabilities.length&&value.capabilities.every(capability=>['tools','resources','app_views'].includes(capability)),'TASK_CAPABILITY_SOURCE_DESCRIPTOR_INVALID');
 requireValue(value.state==='ready'?value.capabilities.length>0:value.reasonCode!==null,'TASK_CAPABILITY_SOURCE_DESCRIPTOR_INVALID');
 return {sourceRef,accountRef,kind:value.kind,displayName:value.displayName,accountDisplayName:value.accountDisplayName,state:value.state,reasonCode:value.reasonCode,capabilities:[...value.capabilities]};
}
export function taskSourceCatalog(inventory){
 if(!Array.isArray(inventory?.taskSources))return {taskSources:[],taskSourcesState:'unknown',taskSourcesReasonCode:'NATIVE_TASK_CAPABILITY_SOURCE_CATALOG_UNAVAILABLE'};
 const selected=inventory.taskSources.slice(0,200).map(taskCapabilitySourceDescriptor),seen=new Set();
 for(const source of selected){const key=JSON.stringify([source.sourceRef.id,source.sourceRef.revision,source.accountRef]);requireValue(!seen.has(key),'TASK_CAPABILITY_SOURCE_DUPLICATE');seen.add(key);}
 return {taskSources:selected,taskSourcesState:inventory.taskSources.length>200?'truncated':'observed',taskSourcesReasonCode:inventory.taskSources.length>200?'TASK_CAPABILITY_SOURCE_CATALOG_TRUNCATED':null};
}
