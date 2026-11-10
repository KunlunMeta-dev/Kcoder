import { IntegrationAdmissionError } from './integrations/core/admission.mjs';
import { THREAD_RUNTIME_HANDOFF_CAPABILITY as capability, isThreadRuntimeHandoffMethod,
  validThreadRuntimeHandoffRequest, validThreadRuntimeHandoffResult } from '../shared/threadRuntimeHandoff.mjs';

export function assertThreadRuntimeHandoffAdmission(message, client, experimental, attached) {
  if (!isThreadRuntimeHandoffMethod(message.method)) return;
  if (!attached || client?.initialized !== true || client?.[capability] !== true || experimental?.[capability] !== true)
    throw new IntegrationAdmissionError(-32601,'THREAD_HANDOFF_NEGOTIATION_REQUIRED');
  if (message.id === undefined || message.id === null || !validThreadRuntimeHandoffRequest(message.method,message.params))
    throw new IntegrationAdmissionError(-32602,'THREAD_HANDOFF_REQUEST_INVALID');
}
export function projectThreadRuntimeHandoffResponse(response,pending) {
  if (!isThreadRuntimeHandoffMethod(pending.method) || response.error) return response;
  if (validThreadRuntimeHandoffResult(pending.method,pending.params,response.result)) return response;
  return {jsonrpc:'2.0',id:response.id,error:{code:-32087,message:'THREAD_HANDOFF_RESULT_UNCONFIRMED'}};
}
