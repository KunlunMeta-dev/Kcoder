import { randomUUID, createHash } from 'node:crypto';
import { WEB_SEARCH_METHODS, webSearchMethod, webSearchCapability, validWebSearchParams, validWebSearchResult } from '../shared/webSearchMethods.mjs';

export const WEB_SEARCH_CAPABILITIES = Object.freeze(['webSearchStatusV1', 'webSearchProbeV1']);
export class SearchDiagnosticOwnerError extends Error {
  constructor(message, code = -32602) { super(message); this.code = code; }
}
/** Native stdio is shared. Unforgeable per-client identities keep its receipt ledger isolated. */
export class BrokerWebSearchDiagnostics {
  #owners = new WeakMap();
  #records = new Set();
  claim(client, message, capabilities, threadOwners) {
    if (!webSearchMethod(message.method)) return null;
    const capability = webSearchCapability(message.method);
    if (!client?.initialized || client[capability] !== true || capabilities?.[capability] !== true)
      throw new SearchDiagnosticOwnerError('SEARCH_DIAGNOSTIC_UNSUPPORTED', -32601);
    if (!validWebSearchParams(message.method, message.params)) throw new SearchDiagnosticOwnerError('SEARCH_DIAGNOSTIC_INVALID_REQUEST');
    if (message.params.threadId && threadOwners.get(message.params.threadId) !== client)
      throw new SearchDiagnosticOwnerError('SEARCH_THREAD_OWNER_REQUIRED', -32023);
    if (message.method === WEB_SEARCH_METHODS.status) return null;
    const originalId = message.params.requestId;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(originalId)) throw new SearchDiagnosticOwnerError('SEARCH_PROBE_INVALID_ID');
    let owner = this.#owners.get(client);
    if (!owner) { owner = { id: randomUUID(), client, records: new Map() }; this.#owners.set(client, owner); }
    const nativeId = `${owner.id}-${createHash('sha256').update(originalId).digest('hex')}`;
    let record = owner.records.get(originalId);
    if (record && record.revision !== message.params.expectedRevision) throw new SearchDiagnosticOwnerError('SEARCH_PROBE_BINDING_CONFLICT');
    if (message.method === WEB_SEARCH_METHODS.start && !record) {
      if (owner.records.size >= 32 || this.#records.size >= 256) throw new SearchDiagnosticOwnerError('SEARCH_PROBE_RECEIPT_LIMIT');
      record = { owner, originalId, nativeId, revision: message.params.expectedRevision, active: true };
      owner.records.set(originalId, record); this.#records.add(record);
    }
    return { originalId, nativeId, revision: message.params.expectedRevision, record };
  }
  rewrite(message, ticket) { return ticket ? { ...message, params: { ...message.params, requestId: ticket.nativeId } } : message; }
  response(message, ticket) {
    if (!ticket || message.error) return message;
    const result = message.result;
    if (!validWebSearchResult(WEB_SEARCH_METHODS.read, result) || result.requestId !== ticket.nativeId || result.revision !== ticket.revision)
      return { jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'SEARCH_PROBE_RECEIPT_MISMATCH' } };
    if (ticket.record) ticket.record.active = result.state === 'running' || result.state === 'unknown';
    return { ...message, result: { ...result, requestId: ticket.originalId } };
  }
  detach(client) {
    const owner = this.#owners.get(client);
    if (!owner) return [];
    const requests = [];
    for (const record of owner.records.values()) {
      if (record.active) requests.push({ method: WEB_SEARCH_METHODS.cancel, params: { requestId: record.nativeId, expectedRevision: record.revision } });
      this.#records.delete(record);
    }
    this.#owners.delete(client);
    return requests;
  }
  capabilities(experimental, client) {
    const projected = { ...experimental };
    for (const capability of WEB_SEARCH_CAPABILITIES)
      if (Object.hasOwn(projected, capability)) projected[capability] = client?.[capability] === true && projected[capability] === true;
    return projected;
  }
  clear() { this.#owners = new WeakMap(); this.#records.clear(); }
}
