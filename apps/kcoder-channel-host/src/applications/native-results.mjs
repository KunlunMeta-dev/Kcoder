import { requireValue } from '../errors.mjs';
import { identifier,scopeKey } from '../validation.mjs';
export const TASK_STATES=new Set(['queued','running','waiting_for_user','completed','failed','cancelled','outcome_unknown']);
export const OPERATION_PHASES=new Set(['pending','executing','accepted','completed','rejected','unknown','cancel_requested','cancelled']);
export function validateNativeReply(request,response){
 requireValue(response&&response.contractVersion==='parallel-v1'&&response.requestId===request.requestId,'NATIVE_REPLY_IDENTITY_MISMATCH','reconcile_original');
 requireValue(['accepted','completed','rejected','unknown','unavailable'].includes(response.status),'NATIVE_REPLY_INVALID');
 requireValue(Object.hasOwn(response,'operationId')&&Object.hasOwn(response,'entityRevision')&&Object.hasOwn(response,'result')&&Object.hasOwn(response,'error'),'NATIVE_REPLY_INVALID');
 if(['accepted','completed'].includes(response.status))requireValue(response.error===null,'NATIVE_REPLY_INVALID');
 else requireValue(response.result===null&&response.error&&typeof response.error.code==='string','NATIVE_REPLY_INVALID');
 if(response.status==='accepted')requireValue(response.operationId===request.operationId&&typeof response.operationId==='string','NATIVE_REPLY_IDENTITY_MISMATCH');
 return response;
}
export function policyDecision(value){
 requireValue(value&&['allow','deny','unknown'].includes(value.decision)&&typeof value.policyRevision==='string'&&value.policyRevision.length>0&&typeof value.reasonCode==='string','NATIVE_POLICY_RESULT_INVALID');
 return value.decision;
}
export function runtimeAcceptance(value){
 requireValue(value&&typeof value.threadId==='string'&&['queued','running'].includes(value.state),'NATIVE_ACCEPTANCE_INVALID');
 identifier(value.threadId);
 if(value.turnId!=null)identifier(value.turnId);
 if(value.taskId!=null)identifier(value.taskId);
 return value;
}
export function runtimeReference(value){
 identifier(value?.threadId);
 if(value.turnId){identifier(value.turnId);return {threadId:value.threadId,turnId:value.turnId};}
 if(value.taskId){identifier(value.taskId);return {threadId:value.threadId,taskId:value.taskId};}
 requireValue(false,'NATIVE_EXACT_TASK_REFERENCE_REQUIRED','reconcile_original');
}
export function runtimeTask(value,expected){
 const reference=typeof expected==='string'?{threadId:expected}:runtimeReference(expected);
 requireValue(value&&value.threadId===reference.threadId&&(!reference.turnId||value.turnId===reference.turnId)&&(!reference.taskId||value.taskId===reference.taskId)&&TASK_STATES.has(value.state)&&Array.isArray(value.artifactRefs??[])&&Array.isArray(value.pendingInteractions??[]),'NATIVE_TASK_IDENTITY_MISMATCH');
 if(value.output!=null)requireValue(typeof value.output==='string','NATIVE_TASK_OUTPUT_INVALID');
 return {...value,artifactRefs:value.artifactRefs??[],pendingInteractions:value.pendingInteractions??[]};
}
export function operationReceipt(value,scope,id){
 requireValue(value&&Object.hasOwn(value,'receipt')&&Object.keys(value).every(key=>['receipt','unsubmittedInput'].includes(key)),'NATIVE_OPERATION_RESULT_INVALID');
 if(value.receipt===null)return null;
 const receipt=value.receipt;
 requireValue(receipt&&receipt.operationId===id&&OPERATION_PHASES.has(receipt.phase)&&scopeKey(receipt.scope)===scopeKey(scope),'NATIVE_OPERATION_IDENTITY_MISMATCH');
 if(receipt.runtimeAcceptance!=null)runtimeAcceptance(receipt.runtimeAcceptance);
 if(value.unsubmittedInput!=null){
  const proof=value.unsubmittedInput;
  requireValue(proof&&Object.keys(proof).length===3&&proof.operationId===id
   &&proof.operationRevision===receipt.revision&&Number.isSafeInteger(proof.operationRevision)&&proof.operationRevision>0
   &&typeof proof.threadId==='string'&&receipt.phase==='unknown'&&receipt.runtimeAcceptance==null,
  'NATIVE_UNSUBMITTED_INPUT_INVALID');
  identifier(proof.threadId);
 }
 return receipt;
}
