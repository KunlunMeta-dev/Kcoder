import { MigrationSourceCredentialsBridge } from './migration-source-credentials-bridge.js';
import { createHash } from 'node:crypto';
import { MigrationSourceBridge, normalizeMigrationSourceSelections } from './migration-source-bridge.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw new MigrationSourceBridgeError(reason); };
const stableEndpoint = endpoint => ({ targetFingerprint: endpoint.captured.targetFingerprint, principal: endpoint.captured.principal });
function control(value) {
  if (value === null) return null;
  if (!value || Object.keys(value).some(key => !['sequence', 'cancelWatermark', 'cancelled', 'ready'].includes(key)) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.cancelWatermark) || value.cancelWatermark < 0 ||
      typeof value.cancelled !== 'boolean' || typeof value.ready !== 'boolean') fail('source_transfer_invalid_request');
  return { sequence: value.sequence, cancelWatermark: value.cancelWatermark, cancelled: value.cancelled, ready: value.ready };
}
function resume(value) {
  if (value == null) return null;
  if (!value || Object.keys(value).some(key => !['source', 'target'].includes(key))) fail('source_transfer_invalid_request');
  const result = {};
  if (value.source) {
    const v = value.source;
    if (Object.keys(v).some(key => !['sequence', 'cancelWatermark', 'snapshotControl'].includes(key)) ||
        !Object.hasOwn(v, 'snapshotControl') || !Number.isSafeInteger(v.sequence) || v.sequence < 0 ||
        !Number.isSafeInteger(v.cancelWatermark) || v.cancelWatermark < 0) fail('source_transfer_invalid_request');
    result.source = { sequence: v.sequence, cancelWatermark: v.cancelWatermark, snapshotControl: control(v.snapshotControl) };
  }
  if (value.target) {
    const v = value.target;
    if (Object.keys(v).some(key => !['sequence', 'cancelWatermark', 'admissionControl'].includes(key))) fail('source_transfer_invalid_request');
    result.target = { admissionControl: control(v.admissionControl) };
    if (v.sequence != null || v.cancelWatermark != null) {
      if (!Number.isSafeInteger(v.sequence) || v.sequence < 0 || !Number.isSafeInteger(v.cancelWatermark) || v.cancelWatermark < 0) fail('source_transfer_invalid_request');
      result.target.sequence = v.sequence; result.target.cancelWatermark = v.cancelWatermark;
    }
  }
  return Object.keys(result).length ? result : null;
}

/** Native owns the durable binding/admission/lease. This bounded map is only a
 * Gateway observation cache; its absence can never authorize replay. */
export class MigrationSourceTransferService {
  #records = new Map();
  #leases = new WeakMap();
  #sessionBindings = new Map();
  #running = 0;
  #closed = false;
  #privateCredentials = null;
  constructor({ owner, bridge = new MigrationSourceBridge(), maxOperations = 256, maxRunning = 4,
    maxDurationMs = 30 * 60_000 } = {}) {
    if (typeof owner?.existingLease !== 'function' || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 256 ||
        !Number.isSafeInteger(maxRunning) || maxRunning < 1 || maxRunning > 32 ||
        !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60 * 60_000) fail('source_transfer_invalid_request');
    this.owner = owner; this.bridge = bridge; this.maxOperations = maxOperations; this.maxRunning = maxRunning; this.maxDurationMs = maxDurationMs;
  }
  async #context(options, targetOnly = false) {
    if (this.#closed || !UUID.test(options.requestId) || !options.target || !targetOnly && !options.source) fail('source_transfer_invalid_request');
    if (!['target', 'target-recovery'].includes(options.target.purpose) || !targetOnly && options.source.purpose !== 'source') fail('source_transfer_role_mismatch');
    const leases = await Promise.all([...(targetOnly ? [] : [this.owner.existingLease(options.source)]), this.owner.existingLease(options.target)]);
    for (const lease of leases) lease.assertCurrent();
    const target = leases.at(-1).endpoint, source = targetOnly ? undefined : leases[0].endpoint;
    if (source && source.captured.ownerId !== target.captured.ownerId) fail('source_transfer_authority_changed');
    return { requestId: options.requestId, source, target, leases,
      sessions: [...(!targetOnly ? [options.source] : []), options.target].map(s => s.sessionId + '/' + s.purpose),
      stable: { source: source ? stableEndpoint(source) : null, target: stableEndpoint(target) } };
  }
  #record(context) {
    let record = this.#records.get(context.requestId);
    if (record && (record.binding.target && context.stable.target && hash(record.binding.target) !== hash(context.stable.target) ||
        record.binding.source && context.stable.source && hash(record.binding.source) !== hash(context.stable.source))) fail('source_transfer_request_changed');
    for (const lease of context.leases) {
      const old = this.#leases.get(lease);
      if (old && old !== context.requestId) fail('source_transfer_session_in_use');
    }
    for (const key of context.sessions) {
      const old = this.#sessionBindings.get(key);
      if (old && old !== context.requestId) fail('source_transfer_session_in_use');
    }
    // Keep released-session bindings to reject cross-request reuse, but bound
    // recovery churn independently of the number of logical operations.
    const addedSessions = new Set(context.sessions.filter(key => !this.#sessionBindings.has(key)));
    if (this.#sessionBindings.size + addedSessions.size > this.maxOperations * 64) fail('source_transfer_session_binding_limit');
    if (!record) {
      if (this.#records.size >= this.maxOperations) fail('source_transfer_operation_limit');
      record = { requestId: context.requestId, binding: context.stable, context, result: null, progress: null,
        state: 'unknown', errorCode: null, task: null, controller: null, attempts: new Map(), selectionDigest: null };
      this.#records.set(context.requestId, record);
    }
    if (!record.binding.target && context.stable.target) record.binding.target = context.stable.target;
    if (!record.binding.source && context.stable.source) record.binding.source = context.stable.source;
    for (const lease of context.leases) this.#leases.set(lease, context.requestId);
    for (const key of context.sessions) this.#sessionBindings.set(key, context.requestId);
    if (context.source && context.target) {
      if (record.pairedContext && record.pairedContext !== context && !record.task) {
        const older = record.pairedContext;
        if (older.leases.some((lease, index) => lease !== context.leases[index])) void this.#cleanup(older);
      }
      record.pairedContext = context;
    }
    record.context = context;
    return record;
  }
  #view(record) {
    return structuredClone({ requestId: record.requestId, coordinatorState: record.state,
      observation: record.result ? 'observed' : 'unobserved', result: record.result,
      progress: record.progress, errorCode: record.errorCode });
  }
  async #observe(record, context) {
    const value = context.source ? await this.bridge.read(context) : await this.bridge.readTarget(context);
    for (const lease of context.leases) lease.assertCurrent();
    record.result = value;
    return value;
  }
  async #receivedOperation(options, method) {
    const context = await this.#context(options, true);
    this.#record(context);
    const result = await this.bridge[method]({ ...options, target: context.target });
    for (const lease of context.leases) lease.assertCurrent();
    return result;
  }
  async #privateOperation(options, method, targetOnly, operation) {
    const context = await this.#context(options, targetOnly);
    this.#record(context);
    this.#privateCredentials ??= new MigrationSourceCredentialsBridge({ transferBridge: this.bridge });
    const value = await this.#privateCredentials[method]({ ...options, source: context.source, target: context.target }, operation);
    for (const lease of context.leases) lease.assertCurrent();
    return value;
  }
  async privateSourceRead(options) {
    if (this.#closed || !UUID.test(options.requestId) || options.source?.purpose !== 'source') fail('source_transfer_invalid_request');
    const lease = await this.owner.existingLease(options.source); lease.assertCurrent();
    const source = lease.endpoint;
    const context = { requestId: options.requestId, source, target: undefined, leases: [lease],
      sessions: [options.source.sessionId + '/' + options.source.purpose], stable: { source: stableEndpoint(source), target: null } };
    this.#record(context);
    this.#privateCredentials ??= new MigrationSourceCredentialsBridge({ transferBridge: this.bridge });
    const value = await this.#privateCredentials.sourceRead({ ...options, source });
    lease.assertCurrent();
    return value;
  }
  async privatePreparationStatus(options) { return this.#privateOperation(options, 'preparationStatus', true); }
  async privateCandidates(options) { return this.#privateOperation(options, 'candidates', true); }
  async privateRun(options) { return this.#privateOperation(options, 'run', false); }
  async privateRead(options) { return this.#privateOperation(options, 'read', true); }
  async privateCancel(options) { return this.#privateOperation(options, 'control', options.side === 'target', 'cancel'); }
  async privateResume(options) { return this.#privateOperation(options, 'control', options.side === 'target', 'resume'); }
  async privatePrepare(options) { return this.#privateOperation(options, 'prepare', true); }
  async privateRelease(options) { return this.#privateOperation(options, 'release', true); }
  async received(options) { return this.#receivedOperation(options, 'received'); }
  async adoptionPrepare(options) { return this.#receivedOperation(options, 'adoptionPrepare'); }
  async adoptionRead(options) { return this.#receivedOperation(options, 'adoptionRead'); }
  async adoptionResume(options) { return this.#receivedOperation(options, 'adoptionResume'); }
  async adoptionCancel(options) { return this.#receivedOperation(options, 'adoptionCancel'); }
  async read(options) {
    const context = await this.#context(options), record = this.#record(context);
    await this.#observe(record, context);
    return this.#view(record);
  }
  async targetRead(options) {
    const context = await this.#context(options, true), record = this.#record(context);
    await this.#observe(record, context);
    return this.#view(record);
  }
  async #schedule(record, context, options, kind, work) {
    if (!UUID.test(options.attemptId)) fail('source_transfer_invalid_request');
    const previous = record.attempts.get(options.attemptId);
    if (previous) {
      const semantic = await work.prepare();
      await previous.accepted;
      if (semantic.callDigest !== previous.callDigest) fail('source_transfer_attempt_conflict');
      return this.#view(record);
    }
    if (record.task) fail('source_transfer_busy');
    if (this.#running >= this.maxRunning) fail('source_transfer_running_limit');
    if (record.attempts.size >= 256) fail('source_transfer_attempt_limit');
    this.#running++; record.state = 'running'; record.errorCode = null;
    const controller = new AbortController(); record.controller = controller; record.activeContext = context;
    let accept;
    const accepted = new Promise(resolve => { accept = resolve; });
    const entry = { accepted, callDigest: null }; record.attempts.set(options.attemptId, entry);
    const timer = setTimeout(() => {
      record.errorCode = 'source_transfer_time_budget_exceeded'; controller.abort(); void this.#cleanup(context);
    }, this.maxDurationMs); timer.unref?.();
    let finished = false;
    const settle = async (claimed, claimDispatched) => {
      if (finished) return; finished = true;
      if (claimed || claimDispatched) {
        try {
          const released = await this.bridge.releaseAttempt({ ...context, attemptId: options.attemptId });
          if (claimed && !released.released) fail('source_transfer_cleanup_unconfirmed');
        } catch {
          record.state = 'unknown'; record.errorCode ??= 'source_transfer_cleanup_unconfirmed';
          await this.#cleanup(context);
        }
      }
      clearTimeout(timer); this.#running--; record.task = null; record.controller = null; record.activeContext = null;
    };
    record.task = accepted;
    let claimDispatched = false;
    try {
      const semantic = await work.prepare(); entry.callDigest = semantic.callDigest;
      if (controller.signal.aborted) fail('source_transfer_interrupted');
      claimDispatched = true;
      const claim = await this.bridge.claimAttempt({ ...context, attemptId: options.attemptId, kind,
        callDigest: semantic.callDigest, selectionDigest: semantic.selectionDigest });
      if (claim.view.attempt?.attemptId !== options.attemptId || claim.view.attempt?.callDigest !== semantic.callDigest ||
          claim.view.attempt?.kind !== kind || claim.view.attempt?.selectionDigest !== (semantic.selectionDigest ?? null)) fail('source_transfer_attempt_conflict');
      if (record.bindingDigest && record.bindingDigest !== claim.view.bindingDigest) fail('source_transfer_request_changed');
      record.bindingDigest = claim.view.bindingDigest; record.selectionDigest = claim.view.selectionDigest;
      if (!claim.admitted) {
        record.state = 'unknown'; record.errorCode = 'source_transfer_attempt_unconfirmed';
        // An old accepted attempt is never executed again, even if no business
        // mutation became visible before its original Gateway died.
        await this.#observe(record, context);
        await settle(false, false); accept();
        return this.#view(record);
      }
      const task = (async () => {
        try {
          if (controller.signal.aborted) fail('source_transfer_interrupted');
          record.result = await work.execute(semantic, controller.signal, progress => { record.progress = structuredClone(progress); });
          for (const lease of context.leases) lease.assertCurrent();
          record.state = 'idle';
        } catch (error) {
          record.state = 'unknown';
          record.errorCode ??= error instanceof MigrationSourceBridgeError ? error.reason : 'source_transfer_outcome_unknown';
          if (controller.signal.aborted || context.leases.some(lease => { try { lease.assertCurrent(); return false; } catch { return true; } })) {
            await this.#cleanup(context);
          }
        } finally { await settle(true, false); }
      })();
      record.task = task;
      // Native has durably accepted before HTTP admission is acknowledged.
      // The unbounded copy/capture remains owned by the background task.
      accept(); return this.#view(record);
    } catch (error) {
      record.state = 'unknown';
      record.errorCode ??= error instanceof MigrationSourceBridgeError ? error.reason : 'source_transfer_outcome_unknown';
      await settle(false, claimDispatched); accept();
      return this.#view(record);
    }
  }
  async run(options) {
    const context = await this.#context(options), record = this.#record(context);
    const selected = options.selections == null ? undefined : normalizeMigrationSourceSelections(options.selections);
    const frozen = resume(options.resume);
    return this.#schedule(record, context, options, 'run', {
      prepare: async () => {
        // Missing UI selections are recovered only from Native's original intent.
        const effective = selected ?? await this.bridge.savedSelections(context);
        if (!effective) fail('source_transfer_selection_unavailable');
        const selectionDigest = hash(effective);
        if (record.selectionDigest && record.selectionDigest !== selectionDigest) fail('source_transfer_request_changed');
        return { selectionDigest, callDigest: hash({ kind: 'run', selectionDigest, resume: frozen }) };
      },
      execute: (_admission, signal, onProgress) => this.bridge.run({ ...context, selections: selected,
        ...(frozen ? { resume: frozen } : {}), signal, onProgress }),
    });
  }
  async cancel(options) {
    if (!UUID.test(options.commandId)) fail('source_transfer_invalid_request');
    const context = await this.#context(options), record = this.#record(context);
    record.result = await this.bridge.cancel({ ...context, commandId: options.commandId });
    return this.#view(record);
  }
  async targetCancel(options) {
    if (!UUID.test(options.commandId)) fail('source_transfer_invalid_request');
    const context = await this.#context(options, true), record = this.#record(context);
    record.result = await this.bridge.cancelTarget({ ...context, commandId: options.commandId });
    return this.#view(record);
  }
  async targetResume(options) {
    const context = await this.#context(options, true), record = this.#record(context);
    if (!Object.hasOwn(options, 'expectedOperationControl')) fail('source_transfer_invalid_request');
    const admission = control(options.expectedAdmissionControl), operation = control(options.expectedOperationControl);
    if (!admission) fail('source_transfer_invalid_request');
    return this.#schedule(record, context, options, 'target_resume', {
      prepare: async () => ({ selectionDigest: null, callDigest: hash({ kind: 'target_resume', admission, operation }) }),
      execute: () => this.bridge.resumeTarget({ ...context, expectedAdmissionControl: admission, expectedOperationControl: operation }),
    });
  }
  async targetFinish(options) {
    const context = await this.#context(options, true), record = this.#record(context);
    return this.#schedule(record, context, options, 'finish', {
      prepare: async () => ({ selectionDigest: null, callDigest: hash({ kind: 'finish' }) }),
      execute: () => this.bridge.finishTarget(context),
    });
  }
  async #cleanup(context) { await Promise.allSettled(context.leases.map(lease => lease.release())); }
  async sweep() {
    await Promise.all([...this.#records.values()].map(async record => {
      const contexts = new Set([record.activeContext, record.pairedContext, record.context].filter(Boolean));
      await Promise.all([...contexts].map(async context => {
        try { for (const lease of context.leases) lease.assertCurrent(); }
        catch { if (record.activeContext === context) record.controller?.abort(); await this.#cleanup(context); }
      }));
    }));
  }
  async close() {
    this.#closed = true;
    for (const record of this.#records.values()) record.controller?.abort();
    await Promise.all([...this.#records.values()].flatMap(record =>
      [...new Set([record.activeContext, record.pairedContext, record.context].filter(Boolean))].map(context => this.#cleanup(context))));
    return { running: this.#running };
  }
  get running() { return this.#running; }
}
