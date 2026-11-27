// Logical WebSocket ownership above one shared native connection's view registry.
export const MIGRATION_VIEW_PREFIX = 'migration/history/view/';
export const MIGRATION_VIEW_CREATIONS = Object.freeze([
  `${MIGRATION_VIEW_PREFIX}open`, `${MIGRATION_VIEW_PREFIX}renew`,
]);

export class MigrationViewOwnerError extends Error {
  constructor(message, code = -32020) { super(message); this.code = code; }
}

const METHODS = new Set(['open', 'read', 'renew', 'release'].map(name => `${MIGRATION_VIEW_PREFIX}${name}`));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BrokerMigrationViewLeases {
  #records = new Map();

  claim(owner, message) {
    if (!METHODS.has(message.method)) return null;
    if (owner?.initialized !== true) throw new MigrationViewOwnerError('Initialize is required before a history view', -32002);
    const params = message.params;
    if (!params || !UUID.test(params.requestId ?? '')) throw new MigrationViewOwnerError('Invalid history view request identity', -32602);
    const current = this.#records.get(params.requestId);
    if (current && current.owner !== owner) throw new MigrationViewOwnerError('History view belongs to another logical client');
    const open = message.method === `${MIGRATION_VIEW_PREFIX}open`;
    if (current?.abandoned && (open || message.method.endsWith('/renew'))) {
      throw new MigrationViewOwnerError('Expired history view requires a new explicit open');
    }
    if (open && (!UUID.test(params.jobId ?? '') || typeof params.expectedArchiveId !== 'string' || params.expectedArchiveId.length > 128 ||
        (params.viewId != null && (typeof params.viewId !== 'string' || params.viewId.length > 128)))) {
      throw new MigrationViewOwnerError('Invalid history view selection', -32602);
    }
    if (!open && !current) throw new MigrationViewOwnerError('History view has no owner on this logical client');
    if (!open && params.leaseId != null && params.leaseId !== current.lease) {
      throw new MigrationViewOwnerError('History view lease does not belong to this logical client');
    }
    if (['renew', 'release'].some(name => message.method === `${MIGRATION_VIEW_PREFIX}${name}`) && !current?.lease) {
      throw new MigrationViewOwnerError('Read back the original history view before changing it');
    }
    if (current && open && (current.job !== params.jobId || current.archive !== params.expectedArchiveId || current.view !== (params.viewId ?? null))) {
      throw new MigrationViewOwnerError('History view request identity is already bound to another selection');
    }
    if (!current && this.#records.size >= 256) throw new MigrationViewOwnerError('History view request capacity reached');
    const record = current ?? { owner, request: params.requestId, job: params.jobId, archive: params.expectedArchiveId,
      view: params.viewId ?? null, lease: null, active: false, cleanupSent: false, abandoned: false };
    if (!current) this.#records.set(params.requestId, record);
    return { record, method: message.method };
  }

  response(ticket, response, attached) {
    if (!ticket || response.error) return null;
    const record = ticket.record;
    if (this.#records.get(record.request) !== record) return null;
    const lease = response.result?.lease;
    if (!lease) return null;
    if (lease.requestId !== record.request || lease.jobId !== record.job || lease.archiveId !== record.archive ||
        (lease.viewId ?? null) !== record.view || !UUID.test(lease.leaseId ?? '') ||
        (record.lease !== null && record.lease !== lease.leaseId)) {
      // A mismatching response never grants authority to release an unrelated native lease.
      throw new MigrationViewOwnerError('History view response does not match its original owner');
    }
    record.lease = lease.leaseId;
    record.active = lease.state === 'active' || lease.state === 'invalidated';
    if (!attached || record.owner === null || record.abandoned) return this.#cleanup(record);
    return null;
  }

  #cleanup(record) {
    if (!record.lease || !record.active || record.cleanupSent) return null;
    record.cleanupSent = true;
    return { method: `${MIGRATION_VIEW_PREFIX}release`, params: { requestId: record.request, leaseId: record.lease } };
  }

  abandoned(ticket) { return ticket?.record?.abandoned === true; }

  abandon(ticket) {
    if (!ticket) return null;
    ticket.record.abandoned = true;
    return this.#cleanup(ticket.record);
  }

  detach(owner) {
    const cleanup = [];
    for (const record of this.#records.values()) {
      if (record.owner !== owner) continue;
      record.owner = null;
      const request = this.#cleanup(record);
      if (request) cleanup.push(request);
    }
    return cleanup;
  }

  clear() { this.#records.clear(); }
}
