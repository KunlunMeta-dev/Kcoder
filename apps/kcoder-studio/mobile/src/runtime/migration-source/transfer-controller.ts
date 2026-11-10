import { migrationRequestId } from '../migration-client';
import { createMigrationSourceSessionClient } from './sessions';
import { createMigrationSourceTransferClient } from './transfers';
import { createMigrationSourceTransferRecovery } from './transfer-recovery';
import { MigrationSourceHttpError, type MigrationSourceHttpOptions } from './http';
import type { SourceTarget } from './catalog';
import * as C from '../../../../shared/generated/contracts';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>;
interface Snapshot { busy: boolean; error: string | null; input: C.MigrationSourceTransferRunParams | null; result: C.MigrationSourceTransferResult | null; }
/** Explicit transfers retain request/attempt identities; Native alone supplies completion receipts. */
export class MobileSourceTransfer {
  private state: Snapshot = { busy: false, error: null, input: null, result: null };
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private readonly owner = migrationRequestId();
  private readonly sessions;
  private readonly cleanupSessions;
  private readonly client;
  private readonly recovery;
  private readonly prefix: string;
  constructor(private options: MigrationSourceHttpOptions & { target: SourceTarget; storage: StoragePort; scope: string; isCurrent(): boolean }) {
    this.options = { ...options, target: { ...options.target } };
    this.sessions = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => this.current() ? this.owner : '' });
    this.cleanupSessions = createMigrationSourceSessionClient({ profile: options.profile, captureScope: () => this.owner });
    this.client = createMigrationSourceTransferClient({ profile: options.profile, captureScope: () => this.current() ? this.owner : '' });
    this.recovery = createMigrationSourceTransferRecovery({ profile: options.profile, storage: options.storage, recoveryScope: options.scope, captureScope: () => this.current() ? this.owner : '' });
    this.prefix = `kcoder-studio:mobile-transfer-control:${encodeURIComponent(options.scope)}:`;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = () => { this.active = true; };
  private current() { return this.active && this.options.isCurrent(); }
  private update(patch: Partial<Snapshot>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const f of this.listeners) f(); } }
  private check() { if (!this.current()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false); }
  private async release() { if (this.state.input) { try { await this.cleanupSessions.close(this.state.input.target); } catch { /* Original Gateway retains uncertain cleanup authority. */ } } }
  dispose = () => { this.active = false; this.generation++; void this.release(); };
  private async perform(work: (valid: () => boolean) => Promise<C.MigrationSourceTransferResult>) {
    if (!this.current() || this.state.busy) return;
    const ticket = ++this.generation, valid = () => this.current() && ticket === this.generation;
    this.update({ busy: true, error: null });
    try { const result = await work(valid); if (valid()) this.update({ result }); }
    catch (error) { if (valid()) this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' }); }
    finally { if (valid()) this.update({ busy: false }); else if (!this.current()) await this.release(); }
  }
  start = (source: C.MigrationSourceSessionParams, selections: C.MigrationSourceSelectionV1[]) => this.perform(async valid => {
    if (this.state.input || !selections.length || selections.length > 64) throw new MigrationSourceHttpError('source_transfer_reconcile_required', false);
    const input: C.MigrationSourceTransferRunParams = { requestId: migrationRequestId(), attemptId: migrationRequestId(), source: structuredClone(source), target: { sessionId: migrationRequestId(), purpose: 'target', targetId: this.options.target.id, ...(this.options.target.workspacePath === undefined ? {} : { workspacePath: this.options.target.workspacePath }) }, selections: structuredClone(selections) };
    this.update({ input });
    const opened = await this.sessions.open(input.target); this.check();
    if (!valid()) throw new MigrationSourceHttpError('source_transfer_authority_changed', false);
    if (opened.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_target_not_ready', false);
    return this.recovery.start(input);
  });
  read = () => this.perform(async () => {
    if (!this.state.input) throw new MigrationSourceHttpError('source_transfer_recovery_missing', false);
    return this.recovery.reconcile(this.state.input.requestId);
  });
  cancel = async () => {
    const input = this.state.input; if (!this.current() || !input || !this.recovery.load(input.requestId)) return;
    const ticket = ++this.generation, valid = () => this.current() && ticket === this.generation;
    this.update({ busy: true, error: null });
    try {
      const key = this.prefix + input.requestId + ':cancel'; let commandId = this.options.storage.getItem(key);
      if (!commandId) { commandId = migrationRequestId(); this.options.storage.setItem(key, commandId); }
      if (!C.isMigrationSourceTransferCancelParams({ requestId: input.requestId, source: input.source, target: input.target, commandId }) || this.options.storage.getItem(key) !== commandId) throw new MigrationSourceHttpError('source_transfer_recovery_invalid', false);
      const result = await this.client.cancel({ requestId: input.requestId, source: input.source, target: input.target, commandId }); if (valid()) this.update({ result });
    } catch (error) { if (valid()) this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' }); }
    finally { if (valid()) this.update({ busy: false }); }
  };
  resume = (confirmed: C.MigrationSourceTransferResult) => this.perform(async () => {
    const input = this.state.input; if (!input || confirmed.requestId !== input.requestId) throw new MigrationSourceHttpError('source_transfer_request_changed', false);
    const fresh = await this.recovery.reconcile(input.requestId); this.check(); this.update({ result: fresh });
    const value = fresh.result, old = confirmed.result;
    if (value?.phase === 'ready') return fresh;
    if (fresh.coordinatorState === 'running' || !value || 'scope' in value || !old || 'scope' in old || value.targetWorkerRunning || !value.sourceState || !value.targetAdmissionControl) throw new MigrationSourceHttpError('source_transfer_control_unavailable', false);
    const controls = (v: C.MigrationSourcePairedObservation) => JSON.stringify([v.sourceState, v.sourceSnapshotControl, v.targetState, v.targetAdmissionControl]);
    if (controls(value) !== controls(old)) throw new MigrationSourceHttpError('source_transfer_stale_control', false);
    let request: C.MigrationSourceTransferRunParams = { requestId: input.requestId, source: input.source, target: input.target, attemptId: migrationRequestId(), resume: { source: { sequence: value.sourceState.sequence, cancelWatermark: value.sourceState.cancelWatermark, snapshotControl: value.sourceSnapshotControl }, target: { ...(value.targetState ? { sequence: value.targetState.sequence, cancelWatermark: value.targetState.cancelWatermark } : {}), admissionControl: value.targetAdmissionControl } } };
    const key = this.prefix + input.requestId + ':resume', prior = this.options.storage.getItem(key);
    if (prior) {
      const parsed: unknown = prior.length <= 32 * 1024 ? JSON.parse(prior) : null;
      if (!C.isMigrationSourceTransferRunParams(parsed) || parsed.requestId !== input.requestId || JSON.stringify(parsed.source) !== JSON.stringify(input.source) || JSON.stringify(parsed.target) !== JSON.stringify(input.target) || parsed.selections != null) throw new MigrationSourceHttpError('source_transfer_recovery_invalid', false);
      if (JSON.stringify(parsed.resume) === JSON.stringify(request.resume)) request = parsed;
    }
    const saved = JSON.stringify(request);
    this.options.storage.setItem(key, saved); if (this.options.storage.getItem(key) !== saved) throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false);
    this.check(); const result = await this.client.run(request);
    this.options.storage.setItem(this.prefix + input.requestId + ':cancel', '');
    return result;
  });
}
