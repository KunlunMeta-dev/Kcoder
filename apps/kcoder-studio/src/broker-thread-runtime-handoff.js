import { hasWellFormedJsonStrings } from './broker-json-strings.js';
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
  if (!isThreadRuntimeHandoffMethod(pending.method)) return response;
  const { jsonrpc, method, params, result, error } = response;
  // A valid payload cannot certify release inside an ambiguous RPC envelope.
  if ((jsonrpc === undefined || jsonrpc === '2.0') && method === undefined && params === undefined) {
    if (result === undefined && error && typeof error === 'object' && !Array.isArray(error) &&
        Number.isSafeInteger(error.code) && typeof error.message === 'string' &&
        hasWellFormedJsonStrings(error)) return response;
    if (error === undefined && validThreadRuntimeHandoffResult(pending.method, pending.params, result))
      return response;
  }
  return {jsonrpc:'2.0',id:response.id,error:{code:-32087,message:'THREAD_HANDOFF_RESULT_UNCONFIRMED'}};
}
