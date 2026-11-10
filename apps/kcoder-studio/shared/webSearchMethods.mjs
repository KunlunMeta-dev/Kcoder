import { isContract } from './generated/validator.mjs';

export const WEB_SEARCH_METHODS = Object.freeze({
  status: 'webSearch/status/read',
  start: 'webSearch/probe/start',
  read: 'webSearch/probe/read',
  cancel: 'webSearch/probe/cancel',
});
const definitions = new Map([
  [WEB_SEARCH_METHODS.status, ['WebSearchStatusReadParams', 'WebSearchStatusReadResult', 'webSearchStatusV1']],
  [WEB_SEARCH_METHODS.start, ['WebSearchProbeStartParams', 'WebSearchProbeResult', 'webSearchProbeV1']],
  [WEB_SEARCH_METHODS.read, ['WebSearchProbeReadParams', 'WebSearchProbeResult', 'webSearchProbeV1']],
  [WEB_SEARCH_METHODS.cancel, ['WebSearchProbeReadParams', 'WebSearchProbeResult', 'webSearchProbeV1']],
]);
export function webSearchMethod(method) { return definitions.has(method); }
export function webSearchCapability(method) { return definitions.get(method)?.[2]; }
export function validWebSearchParams(method, value) {
  const definition = definitions.get(method);
  return !!definition && isContract(definition[0], value);
}
export function validWebSearchResult(method, value) {
  const definition = definitions.get(method);
  return !!definition && isContract(definition[1], value);
}

/** Only authoritative pre-dispatch rejections may settle an uncertain start locally. */
export function webSearchProbeRejection(error) {
  if (!(error instanceof Error)) return null;
  if (error.message.includes('SEARCH_DIAGNOSTIC_UNSUPPORTED')) return 'unsupported';
  if (error.message.includes('SEARCH_PROBE_POLICY_DENIED')) return 'policy_denied';
  return /SEARCH_(REVISION_CONFLICT|DIAGNOSTIC_INVALID_REQUEST|PROBE_(RECEIPT_LIMIT|BINDING_CONFLICT|INVALID_ID))/.test(error.message) ? 'rejected' : null;
}
