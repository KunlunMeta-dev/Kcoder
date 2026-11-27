import { privatePrepareRecovery } from './migrationPrivatePrepareRecovery';
import { pendingPrivatePreparation, privatePreparationIdentity } from './migrationPrivatePreparation';
import { createPrivateCredentialRecovery } from './migrationPrivateCredentialRecovery';
import { selectPrivateCredential, type PrivateCredentialChoice } from './migrationPrivateCredentialSelections';
import { isPrivateCredentialError, type privateCredentialClient } from './migrationPrivateCredentials';
import type { MigrationJobReadResult, MigrationBatchStateResult, MigrationSourceCredentialSourcesParams,
  MigrationSourceCredentialSourcesResult, MigrationSourceCredentialSource, MigrationSourceCredentialCandidatesParams,
  MigrationSourceCredentialCandidatesResult, MigrationSourceCredentialSelection, MigrationSourceCredentialRunParams,
  MigrationSourceCredentialResult, MigrationSourceCredentialSide, MigrationSourceCredentialWatermark,
  MigrationSourceCredentialPrepareParams, MigrationSourceSessionParams, MigrationSourceSessionStateResult,
  MigrationSourceSessionCloseResult, MigrationSourceCredentialPreparationResult } from './generated/contracts';

export class PrivateCredentialControllerError extends Error {
  readonly outcomeUnknown = false;
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'PrivateCredentialControllerError'; }
}
type RecordInput = MigrationSourceCredentialRunParams;
type OwnedChild = { value: MigrationSourceSessionParams; ready: boolean; released: boolean };
export interface PrivateCredentialSnapshot {
  busy: boolean; controlBusy: boolean; error: string | null; page: MigrationSourceCredentialSourcesResult | null; pageIndex: number;
  selected: MigrationSourceCredentialSource | null; device: SourceTarget | null;
  candidates: MigrationSourceCredentialCandidatesResult | null; candidateIndex: number;
  selections: Record<string, MigrationSourceCredentialSelection>; records: RecordInput[]; recordIndex: number; nextRecordPage: number | null;
  input: RecordInput | null; result: MigrationSourceCredentialResult | null; included: RecordInput[];
  observed: Partial<Record<MigrationSourceCredentialSide, MigrationSourceCredentialWatermark>>;
  workers: Partial<Record<MigrationSourceCredentialSide, boolean>>;
  prepareUnknown: boolean;
  preparation: MigrationSourceCredentialPreparationResult | null;
}
export interface CredentialSourceTarget { id: string; workspacePath?: string }
type SourceTarget = CredentialSourceTarget
export interface PrivateCredentialControllerOptions {
  target: SourceTarget; scope: string; job: MigrationJobReadResult;
  isCurrent(): boolean; onPrepared(job: MigrationJobReadResult): void; storage?: Storage;
  requestId(): string;
  native: {
    available(): boolean;
    credentialSources(input: MigrationSourceCredentialSourcesParams): Promise<MigrationSourceCredentialSourcesResult>;
    batchRead(input: { jobId: string }): Promise<MigrationBatchStateResult>;
  };
  sessions(captureScope: () => string): {
    open(input: MigrationSourceSessionParams): Promise<MigrationSourceSessionStateResult>;
    close(input: MigrationSourceSessionParams): Promise<MigrationSourceSessionCloseResult>;
  };
  privateClient(captureScope: () => string, defaultSignal: () => AbortSignal): ReturnType<typeof privateCredentialClient>;
}
type Options = PrivateCredentialControllerOptions;
const sameRoute = (a: SourceTarget, b: SourceTarget) => a.id === b.id && (a.workspacePath ?? null) === (b.workspacePath ?? null);
const rowKey = (row: MigrationSourceCredentialSource) => JSON.stringify([row.requestId, row.manifestSha256, row.entryId, row.sourceBindingRevision]);
const inputMatches = (row: MigrationSourceCredentialSource, input: RecordInput) => row.requestId === input.locator.requestId
  && row.manifestSha256 === input.manifestSha256 && row.entryId === input.entryId;
function fail(code: string): never { throw new PrivateCredentialControllerError(code); }
const initialState = (): PrivateCredentialSnapshot => ({ busy: false, controlBusy: false, error: null, page: null, pageIndex: 0, selected: null, device: null,
  candidates: null, candidateIndex: 0, selections: {}, records: [], recordIndex: 0, nextRecordPage: null,
  input: null, result: null, included: [], observed: {}, workers: {}, prepareUnknown: false, preparation: null });

/** Source catalog facts and the original saved plan own selection; local records only locate receipts. */
export class PrivateCredentialController {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly options: Options;
  private readonly identity: string;
  private readonly children = new Set<OwnedChild>();
  private readonly sessions;
  private readonly cleanup;
  private readonly client;
  private abort = new AbortController();
  private active = true;
  private flight = false;
  private controlFlight = false;
  private controlGeneration: number | null = null;
  private generation = 0;
  private flightGeneration: number | null = null;
  private targetChild: OwnedChild | null = null;
  private sourceChild: OwnedChild | null = null;
  private recovery: ReturnType<typeof createPrivateCredentialRecovery> | null = null;
  private readonly knownRows = new Map<string, MigrationSourceCredentialSource>();
  private readonly candidateRows = new Map<string, string>();
  private readonly controlFences = new Map<string, MigrationSourceCredentialWatermark>();
  constructor(options: Options) {
    this.options = { ...options, target: structuredClone(options.target), job: structuredClone(options.job) };
    this.identity = options.requestId();
    const captureScope = () => this.ownerScope();
    this.sessions = options.sessions(captureScope);
    this.cleanup = options.sessions(() => this.identity);
    this.client = options.privateClient(captureScope, () => this.abort.signal);
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = () => {
    if (this.active) return;
    this.active = true; this.generation++; this.abort = new AbortController();
    this.targetChild = null; this.sourceChild = null; this.recovery = null;
    this.knownRows.clear(); this.candidateRows.clear(); this.controlFences.clear();
    this.state = { ...initialState(), busy: this.flight, controlBusy: this.controlFlight };
    for (const listener of this.listeners) listener();
  };
  private visible() { return this.active && this.options.isCurrent() && this.options.native.available()
    && (!this.flight || this.flightGeneration === this.generation)
    && (!this.controlFlight || this.controlGeneration === this.generation); }
  private ownerScope() { return this.visible() ? `${this.identity}:${this.generation}` : ''; }
  private check() { if (!this.visible()) fail('private_credentials_authority_changed'); }
  private update(patch: Partial<PrivateCredentialSnapshot>) {
    if (!this.visible()) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private storage() { this.check(); return this.options.storage ?? localStorage; }
  private cache() {
    this.check();
    return this.recovery ??= createPrivateCredentialRecovery({ storage: this.storage(), client: this.client,
      captureScope: () => this.ownerScope(), recoveryScope: this.options.scope });
  }
  private async release(child: OwnedChild) {
    if (child.released) return;
    try { child.released = (await this.cleanup.close(child.value)).status === 'released'; }
    catch { /* The original authenticated owner retains any uncertain child; no peer is closed. */ }
  }
  dispose = () => { this.active = false; this.generation++; this.abort.abort(); for (const child of this.children) void this.release(child); };
  private async open(purpose: 'target' | 'source') {
    this.check();
    const route = purpose === 'target' ? this.options.target : this.state.device;
    if (!route) fail('private_credentials_source_not_selected');
    let child = purpose === 'target' ? this.targetChild : this.sourceChild;
    if (!child) {
      child = { value: { sessionId: this.options.requestId(), purpose, targetId: route.id,
        ...(route.workspacePath === undefined ? {} : { workspacePath: route.workspacePath }) }, ready: false, released: false };
      this.children.add(child);
      if (purpose === 'target') this.targetChild = child; else this.sourceChild = child;
    }
    const owned = child;
    if (!owned.ready) {
      try {
        const result = await this.sessions.open(owned.value); this.check();
        if (result.status !== 'ready') fail('private_credentials_unavailable');
        owned.ready = true;
      } finally {
        if (!this.visible() || purpose === 'source' && this.sourceChild !== owned) { owned.released = false; await this.release(owned); }
      }
    }
    return owned.value;
  }
  private async perform(work: () => Promise<void>, lane: 'work' | 'control' = 'work') {
    if (!this.visible() || this.controlFlight || lane === 'work' && this.flight) return;
    if (lane === 'work') { this.flightGeneration = this.generation; this.flight = true; this.update({ busy: true, error: null }); }
    else { this.controlGeneration = this.generation; this.controlFlight = true; this.update({ controlBusy: true, error: null }); }
    try { await work(); } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['private_credentials_binding_changed', 'private_credentials_plan_changed'].includes(code)) {
        this.candidateRows.clear();
        this.update({ selected: null, candidates: null, selections: {}, included: [], preparation: null });
      }
      this.update({ error: isPrivateCredentialError(code) || ['migration_invalid_response', 'migration_update_required', 'migration_plan_changed'].includes(code)
        ? code : 'private_credentials_outcome_unknown' });
    } finally {
      if (lane === 'work') { this.flight = false; this.flightGeneration = null; this.update({ busy: false }); }
      else { this.controlFlight = false; this.controlGeneration = null; this.update({ controlBusy: false }); }
    }
  }
  private plan() {
    const planId = this.options.job.batch?.planId;
    if (!planId) fail('private_credentials_saved_plan_required');
    return { jobId: this.options.job.job.jobId, planId };
  }
  load = (pageIndex = 0) => this.perform(async () => {
    const plan = this.plan();
    const page = await this.options.native.credentialSources({ jobId: plan.jobId, pageIndex }); this.check();
    if (page.planId !== plan.planId || page.sequence !== this.options.job.job.sequence
      || this.state.page && (page.sequence !== this.state.page.sequence || page.totalItems !== this.state.page.totalItems)) fail('private_credentials_plan_changed');
    for (const row of page.items) {
      const key = JSON.stringify([row.requestId, row.manifestSha256, row.entryId]), old = this.knownRows.get(key);
      if (old && rowKey(old) !== rowKey(row)) fail('private_credentials_binding_changed');
      this.knownRows.set(key, row);
    }
    this.update({ page, pageIndex });
  });
  select = (row: MigrationSourceCredentialSource) => {
    if (!this.visible() || this.flight || this.controlFlight || !this.state.page?.items.some(item => rowKey(item) === rowKey(row))) return;
    this.candidateRows.clear();
    this.update({ selected: structuredClone(row), candidates: null, selections: {}, records: [], input: null, result: null,
      observed: {}, workers: {}, candidateIndex: 0, recordIndex: 0, nextRecordPage: null, preparation: null });
  };
  device = (route: SourceTarget) => {
    if (!this.visible() || this.flight || this.controlFlight || this.state.device && sameRoute(route, this.state.device)) return;
    if (this.sourceChild) { void this.release(this.sourceChild); this.sourceChild = null; }
    this.update({ device: structuredClone(route), input: null, result: null, observed: {}, workers: {} });
  };
  private refreshRecords(pageIndex = 0) {
    const row = this.state.selected;
    if (!row) return;
    const all: RecordInput[] = [];
    for (let index = 0; index < 7; index++) {
      const page = this.cache().list(index);
      all.push(...page.items.filter(input => inputMatches(row, input)));
      if (page.nextPage === null) break;
    }
    this.update({ records: all.slice(pageIndex * 10, pageIndex * 10 + 10), recordIndex: pageIndex,
      nextRecordPage: (pageIndex + 1) * 10 < all.length ? pageIndex + 1 : null });
  }
  records = (pageIndex: number) => this.perform(async () => {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 6) fail('private_credentials_invalid_page');
    this.refreshRecords(pageIndex);
  });
  candidates = (pageIndex = 0) => this.perform(async () => {
    const row = this.state.selected, plan = this.plan();
    if (!row) fail('private_credentials_invalid_selection');
    const input: MigrationSourceCredentialCandidatesParams = { target: await this.open('target'), jobId: plan.jobId,
      expectedPlanId: plan.planId, requestId: row.requestId, manifestSha256: row.manifestSha256, entryId: row.entryId, pageIndex };
    const page = await this.client.candidates(input); this.check();
    if (page.source !== row.source || page.projectScoped !== row.projectScoped || page.sourceBindingRevision !== row.sourceBindingRevision
      || page.plan?.sequence !== this.state.page?.sequence || this.state.candidates && page.totalItems !== this.state.candidates.totalItems) fail('private_credentials_binding_changed');
    for (const item of page.items) {
      const old = this.candidateRows.get(item.itemId), signature = JSON.stringify(item);
      if (old && old !== signature) fail('private_credentials_binding_changed');
      this.candidateRows.set(item.itemId, signature);
    }
    this.refreshRecords(); this.update({ candidates: page, candidateIndex: pageIndex });
  });
  choose = (itemId: string, choice: PrivateCredentialChoice | null) => {
    if (!this.visible() || this.flight || this.controlFlight || !this.state.selected || !this.state.candidates || !this.targetChild) return;
    const row = this.state.selected, plan = this.plan();
    const selections = { ...this.state.selections }; delete selections[itemId];
    if (choice) {
      const value = selectPrivateCredential({ target: this.targetChild.value, jobId: plan.jobId, expectedPlanId: plan.planId,
        requestId: row.requestId, manifestSha256: row.manifestSha256, entryId: row.entryId, pageIndex: this.state.candidateIndex }, this.state.candidates, itemId, choice);
      if (!value) return;
      if (Object.keys(selections).length >= 64) return;
      selections[itemId] = value;
    }
    this.update({ selections });
  };
  private accept(input: RecordInput, result: MigrationSourceCredentialResult) {
    this.check();
    for (const side of ['source', 'target'] as const) {
      const control = result[`${side}Control`], old = this.controlFences.get(`${input.locator.offerId}:${side}`);
      if (control && old && (control.sequence < old.sequence || control.cancelWatermark < old.cancelWatermark)) return;
    }
    const observed: PrivateCredentialSnapshot['observed'] = {};
    const workers: PrivateCredentialSnapshot['workers'] = {};
    for (const side of ['source', 'target'] as const) {
      const control = result[`${side}Control`];
      if (!control) continue;
      const key = `${input.locator.offerId}:${side}`, old = this.controlFences.get(key);
      if (old && (control.sequence < old.sequence || control.cancelWatermark < old.cancelWatermark)) return;
      this.controlFences.set(key, control); observed[side] = control;
      const running = result[`${side}WorkerRunning`];
      if (running !== null) workers[side] = running;
    }
    this.update({ input, result, observed, workers });
  }
  run = (consent: { apiKeys: boolean; mcpPrivateFields: boolean }) => this.perform(async () => {
    const row = this.state.selected, selections = Object.values(this.state.selections);
    if (!row || !selections.length || selections.some(item => item.kind === 'provider' ? !consent.apiKeys : !consent.mcpPrivateFields)) fail('private_credentials_explicit_consent_required');
    const input: RecordInput = { locator: { target: await this.open('target'), requestId: row.requestId, offerId: this.options.requestId() },
      source: await this.open('source'), manifestSha256: row.manifestSha256, entryId: row.entryId, selections, consent };
    this.check(); this.update({ input: this.cache().locate(input), result: null, observed: {}, workers: {} });
    try { const original = await this.cache().run(input); this.accept(original.input, original.result); }
    finally { if (this.visible()) this.refreshRecords(); }
  });
  read = (input = this.state.input) => this.perform(async () => {
    if (!input || !this.state.selected || !inputMatches(this.state.selected, input)) fail('private_credentials_binding_changed');
    const original = await this.cache().read(input, await this.open('target')); this.accept(original.input, original.result);
  }, 'control');
  include = (checked: boolean) => {
    if (!this.visible() || this.flight || this.controlFlight || !this.state.selected || !this.state.input || !this.state.result?.received || this.state.result.keyReleased
      || this.state.result.targetControl?.cancelled || this.state.result.targetWorkerRunning !== false) return;
    const input = this.state.input, included = this.state.included.filter(item => item.locator.offerId !== input.locator.offerId);
    if (checked) {
      if (included.length >= 16 || included.some(item => item.locator.requestId !== input.locator.requestId)
        || included.reduce((count, item) => count + item.selections.length, input.selections.length) > 64) return;
      included.push(input);
    }
    this.update({ included });
  };
  exclude = (offerId: string) => {
    if (this.visible() && !this.flight && !this.controlFlight) this.update({ included: this.state.included.filter(input => input.locator.offerId !== offerId) });
  };
  sourceRead = () => this.perform(async () => {
    const input = this.state.input;
    if (!input) fail('private_credentials_binding_changed');
    const source = await this.open('source');
    if (!sameRoute({ id: source.targetId, workspacePath: source.workspacePath ?? undefined },
      { id: input.source.targetId, workspacePath: input.source.workspacePath ?? undefined })) fail('private_credentials_binding_changed');
    const result = await this.client.sourceRead({ locator: input.locator, source }); this.check();
    const control = result.sourceControl;
    if (!control) fail('private_credentials_invalid_response');
    const key = `${input.locator.offerId}:source`, old = this.controlFences.get(key);
    if (old && (control.sequence < old.sequence || control.cancelWatermark < old.cancelWatermark)) return;
    this.controlFences.set(key, control);
    this.update({ observed: { ...this.state.observed, source: control },
      workers: { ...this.state.workers, source: result.sourceWorkerRunning! } });
  }, 'control');
  control = (side: MigrationSourceCredentialSide, mode: 'cancel' | 'resume', confirmed?: MigrationSourceCredentialWatermark) => this.perform(async () => {
    const input = this.state.input, observed = this.state.observed[side];
    if (!input) fail('private_credentials_policy_changed');
    if (mode === 'resume') {
      if (!confirmed || !observed || observed.sequence !== confirmed.sequence || observed.cancelWatermark !== confirmed.cancelWatermark) fail('private_credentials_policy_changed');
      if (this.flight || this.state.workers[side] !== false) fail('private_credentials_busy');
    }
    const locator = { ...input.locator, target: await this.open('target') };
    const source = side === 'source' ? await this.open('source') : undefined;
    if (source && (source.targetId !== input.source.targetId || (source.workspacePath ?? null) !== (input.source.workspacePath ?? null))) fail('private_credentials_binding_changed');
    const result = mode === 'cancel' ? await this.client.cancel({ locator, side, commandId: this.cancelId(input, side, confirmed), ...(source ? { source } : {}) })
      : await this.client.resume({ locator, side, expectedControl: { sequence: confirmed!.sequence, cancelWatermark: confirmed!.cancelWatermark }, ...(source ? { source } : {}) });
    this.check();
    if (confirmed && (result.control.sequence < confirmed.sequence || result.control.cancelWatermark < confirmed.cancelWatermark)) fail('private_credentials_invalid_response');
    const key = `${input.locator.offerId}:${side}`, old = this.controlFences.get(key);
    if (old && (result.control.sequence < old.sequence || result.control.cancelWatermark < old.cancelWatermark)) return;
    this.controlFences.set(key, result.control);
    // A side-control receipt is not a combined stopped/received observation.
    this.update({ result: null, observed: { ...this.state.observed, [side]: result.control }, workers: { ...this.state.workers, [side]: result.workerRunning } });
  }, 'control');
  private cancelId(input: RecordInput, side: MigrationSourceCredentialSide, control?: MigrationSourceCredentialWatermark) {
    const key = `kcoder.mobile.private-cancel:${this.options.scope}:${input.locator.offerId}:${side}:${control?.sequence ?? 'unknown'}:${control?.cancelWatermark ?? 'unknown'}`;
    const storage = this.storage(), old = storage.getItem(key), id = old ?? this.options.requestId();
    if (!old) storage.setItem(key, id);
    if (storage.getItem(key) !== id) fail('private_credentials_storage_unavailable');
    return id;
  }
  readBatch = () => this.perform(async () => {
    const fresh = await this.options.native.batchRead({ jobId: this.plan().jobId }); this.check();
    this.options.onPrepared(fresh.state);
  });
  private async observePreparation(target: MigrationSourceSessionParams) {
    const row = this.state.selected;
    if (!row) fail('private_credentials_invalid_selection');
    const result = await this.client.preparationRead({ requestId: row.requestId, jobId: this.plan().jobId, target }); this.check();
    const previous = this.state.preparation;
    if (result.sequence < this.options.job.job.sequence || previous?.requestId === result.requestId && result.sequence < previous.sequence) fail('private_credentials_policy_changed');
    this.update({ preparation: structuredClone(result) });
    return result;
  }
  preparationRead = () => this.perform(async () => {
    await this.observePreparation(await this.open('target'));
  }, 'control');
  restorePreparation = (confirmed: boolean) => this.perform(async () => {
    const previous = this.state.preparation;
    if (!confirmed || previous?.phase !== 'pending') fail('private_credentials_explicit_consent_required');
    const target = await this.open('target'), fresh = await this.observePreparation(target);
    if (privatePreparationIdentity(previous) !== privatePreparationIdentity(fresh)) fail('private_credentials_policy_changed');
    // A peer may have completed the original intent while confirmation was open.
    if (fresh.phase === 'prepared') return;
    const input = pendingPrivatePreparation(fresh, target);
    if (!input || !fresh.originalPlanId) fail('private_credentials_receive_unconfirmed');
    privatePrepareRecovery(this.storage(), this.options.scope, input.jobId).save(fresh.originalPlanId, input);
    this.check(); this.update({ prepareUnknown: true });
    const prepared = await this.client.prepare(input); this.check();
    this.update({ prepareUnknown: false }); this.options.onPrepared(prepared.job);
  });
  prepare = (confirmed: boolean) => this.perform(async () => {
    if (!confirmed || !this.state.included.length) fail('private_credentials_explicit_consent_required');
    const original = this.state.included, plan = this.plan();
    const storage = this.storage(), recovery = privatePrepareRecovery(storage, this.options.scope, plan.jobId);
    const offers = [...original].sort((a, b) => a.locator.offerId.localeCompare(b.locator.offerId));
    const first = offers[0];
    const intent: MigrationSourceCredentialPrepareParams = { locator: first.locator, jobId: plan.jobId, expectedSequence: this.options.job.job.sequence,
      consent: { apiKeys: offers.some(item => item.selections.some(row => row.kind === 'provider')),
        mcpPrivateFields: offers.some(item => item.selections.some(row => row.kind === 'mcp')) },
      ...(offers.length > 1 ? { additionalOffers: offers.slice(1).map(item => item.locator.offerId) } : {}) };
    const saved = recovery.find(intent);
    const fresh = await this.options.native.batchRead({ jobId: plan.jobId }); this.check();
    if (!saved && fresh.state.batch?.planId !== plan.planId) fail('private_credentials_plan_changed');
    if (fresh.workerRunning) fail('private_credentials_busy');
    const target = await this.open('target');
    for (const input of offers) {
      const result = await this.client.read({ ...input.locator, target }); this.check();
      if (!result.received || result.keyReleased || result.targetControl?.cancelled || result.targetWorkerRunning !== false) fail('private_credentials_receive_unconfirmed');
    }
    const input: MigrationSourceCredentialPrepareParams = { ...intent, locator: { ...intent.locator, target },
      expectedSequence: saved?.input.expectedSequence ?? fresh.state.job.sequence };
    recovery.save(saved?.planId ?? plan.planId, input);
    this.check(); this.update({ prepareUnknown: true });
    const prepared = await this.client.prepare(input); this.check();
    this.update({ prepareUnknown: false }); this.options.onPrepared(prepared.job);
  });
}
