import { normalizeBudgetCache, expiredBudgetObservation, expiredBudgetHistoryRow } from './migrationResourceBudgetInvalidation.mjs';
const LIMIT_KEYS = ['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'];
const atom = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));
const sameLimits = (a, b) => LIMIT_KEYS.every(key => a?.[key] === b?.[key]);
const sameIntent = (a, b) => a === null && b === null || !!a && !!b && ['jobId', 'planId', 'requestId', 'expectedPolicyRevision', 'confirm'].every(key => a[key] === b[key]) && sameLimits(a.limits, b.limits);
const sameReceipt = (intent, receipt) => receipt?.jobId === intent.jobId && receipt.requestId === intent.requestId && receipt.previousRevision === intent.expectedPolicyRevision
  && receipt.revision === intent.expectedPolicyRevision + 1 && sameLimits(intent.limits, receipt.limits);

/** Native owns quota authority. This coordinator owns only bounded, scoped recovery selectors. */
export function createResourceBudgetController({ api, storage, scope, jobId, planId, isCurrent, createRequestId, validIntent, validView, canIncrease = () => true }) {
  const key = `kcoder.migration.resource-budget.v1:${scope}:${jobId}`, listeners = new Set();
  let active = true, epoch = 0, observation = null, cache = { version: 2, pending: null, history: [] };
  let state = { busy: false, error: null, view: null, pending: null, receipt: null, checked: false, recoveryBlocked: false, history: [], historyRows: [], inspectedRequestId: null, expiredObservation: null };
  const current = () => { try { return active && isCurrent(); } catch { return false; } };
  const publish = patch => { if (!current()) return; state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const projection = value => ({ pending: copy(value.pending), history: value.history.map(row => row.requestId), historyRows: copy(value.history) });
  const load = (reader = storage) => {
    const text = reader.getItem(key);
    if (text === null) return { version: 2, pending: null, history: [] };
    const value = text.length <= 16 * 1024 ? normalizeBudgetCache(JSON.parse(text), { jobId, validIntent, validView }) : null;
    if (!value) throw new Error('migration_recovery_storage_unavailable');
    return value;
  };
  try { cache = load(); state = { ...state, ...projection(cache) }; }
  catch { state.error = 'recoveryUnavailable'; state.recoveryBlocked = true; }

  // The lock protects only short local metadata work. No Native request is awaited inside it.
  const metadata = async (expectedPending, change) => {
    if (state.recoveryBlocked) return false;
    const metadataEpoch = epoch;
    try {
      if (typeof storage.withTransaction !== 'function') throw new Error('migration_recovery_storage_unavailable');
      const result = await storage.withTransaction(key, local => {
        if (!current() || epoch !== metadataEpoch) throw new Error('migration_scope_changed');
        const fresh = load(local);
        if (!sameIntent(fresh.pending, expectedPending)) return { saved: false, value: fresh };
        const next = change(fresh), text = JSON.stringify(next);
        if (text.length > 16 * 1024) throw new Error('migration_recovery_storage_unavailable');
        if (!current() || epoch !== metadataEpoch) throw new Error('migration_scope_changed');
        local.setItem(key, text);
        if (local.getItem(key) !== text) throw new Error('migration_recovery_storage_unavailable');
        return { saved: true, value: next };
      });
      if (!current() || epoch !== metadataEpoch) return false;
      cache = result.value;
      const changedPending = !sameIntent(state.pending, cache.pending);
      publish({ ...projection(cache), ...(changedPending ? { receipt: null, checked: false, inspectedRequestId: null, expiredObservation: null } : {}), ...(!result.saved ? { error: 'selectorChanged' } : {}) });
      return result.saved;
    } catch (error) {
      if (current()) publish(error instanceof Error && error.message === 'migration_scope_changed' ? { error: 'scopeChanged' } : { recoveryBlocked: true, error: 'recoveryUnavailable' });
      return false;
    }
  };
  const acceptView = (view, requestId, intent) => {
    const query = { jobId, ...(requestId === undefined ? {} : { requestId }) };
    if (!validView(query, view) || state.view?.phase === 'active' && (view.phase !== 'active' || view.policyRevision < state.view.policyRevision)) throw new Error('migration_invalid_response');
    const receipt = view.phase === 'active' ? view.requestedReceipt ?? null : null;
    if (state.receipt && state.inspectedRequestId === requestId && !receipt) throw new Error('migration_invalid_response');
    if (receipt && (receipt.jobId !== jobId || receipt.requestId !== requestId || receipt.revision > view.policyRevision || intent && !sameReceipt(intent, receipt))) throw new Error('migration_invalid_response');
    publish({ view: copy(view), receipt: copy(receipt), checked: true, inspectedRequestId: requestId ?? null,
      expiredObservation: intent ? expiredBudgetObservation(intent, query, view) : null });
  };
  const perform = async (action, mutation = false) => {
    if (!current() || state.busy) return;
    const ticket = ++epoch; publish({ busy: true, error: null });
    const accept = () => current() && ticket === epoch;
    try { await action(accept); }
    catch (error) {
      if (accept()) {
        const code = error instanceof Error ? error.message : '';
        publish({ error: code === 'migration_resource_budget_update_required' ? 'updateRequired'
          : code === 'migration_invalid_parameters' ? 'invalidLimits'
          : code === 'migration_explicit_confirmation_required' ? 'confirmationRequired'
          : code === 'migration_scope_changed' ? 'scopeChanged'
          : code === 'migration_resource_budget_terminal' ? 'jobNotMutable'
          : mutation && !state.receipt ? 'increaseUnknown' : 'readFailed' });
      }
    } finally { if (accept()) publish({ busy: false }); }
  };
  const read = requestId => perform(async accept => {
    try {
      if (typeof storage.refresh !== 'function') throw new Error('migration_recovery_storage_unavailable');
      await storage.refresh(key);
      if (!accept()) return;
      cache = load();
      const changedPending = !sameIntent(state.pending, cache.pending);
      publish({ ...projection(cache), ...(changedPending ? { receipt: null, checked: false, inspectedRequestId: null, expiredObservation: null } : {}) });
    } catch { if (accept()) publish({ recoveryBlocked: true, error: 'recoveryUnavailable' }); }
    if (!accept()) return;
    const pending = state.pending, original = requestId ?? pending?.requestId;
    if (original !== undefined && !atom(original)) throw new Error('migration_invalid_parameters');
    observation = new AbortController();
    const view = await api.read({ jobId, ...(original === undefined ? {} : { requestId: original }) }, { signal: observation.signal });
    if (accept()) acceptView(view, original, pending?.requestId === original ? pending : null);
  });
  const dispatch = async (intent, accept, fresh = false) => {
    if (!accept() || intent.planId !== planId) throw new Error('migration_scope_changed');
    if (fresh && !canIncrease()) throw new Error('migration_resource_budget_terminal');
    const receipt = await api.increase(copy(intent));
    if (!accept()) return;
    if (!sameReceipt(intent, receipt)) throw new Error('migration_invalid_response');
    publish({ receipt: copy(receipt), checked: true, inspectedRequestId: intent.requestId, expiredObservation: null });
    const view = await api.read({ jobId, requestId: intent.requestId });
    if (accept()) acceptView(view, intent.requestId, intent);
  };
  const historyWith = (fresh, row) => [row, ...fresh.history.filter(previous => previous.requestId !== row.requestId)].slice(0, 10);
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    activate() { active = true; if (state.busy) state = { ...state, busy: false }; },
    dispose() { active = false; epoch++; observation?.abort(); storage.close?.(); listeners.clear(); },
    read,
    increase: (limits, expectedPolicyRevision, confirmed) => perform(async accept => {
      const view = state.view;
      if (!canIncrease()) throw new Error('migration_resource_budget_terminal');
      if (!confirmed || state.pending || state.recoveryBlocked || view?.phase !== 'active' || view.policyRevision !== expectedPolicyRevision || !planId) throw new Error('migration_explicit_confirmation_required');
      const intent = { jobId, planId, requestId: createRequestId(), expectedPolicyRevision, limits: copy(limits), confirm: true };
      if (!validIntent(intent) || LIMIT_KEYS.slice(2).some(name => intent.limits[name] !== view.limits[name]) || intent.limits.maxTotalBytes < view.limits.maxTotalBytes
        || intent.limits.maxPayloadFiles < view.limits.maxPayloadFiles || sameLimits(intent.limits, view.limits)) throw new Error('migration_invalid_parameters');
      if (!await metadata(null, fresh => ({ ...fresh, pending: intent }))) return;
      publish({ receipt: null, checked: false, inspectedRequestId: null, expiredObservation: null });
      if (accept()) await dispatch(intent, accept, true);
    }, true),
    resubmit: confirmed => perform(async accept => {
      const intent = state.pending;
      if (!confirmed || !intent || !state.checked || state.inspectedRequestId !== intent.requestId || state.receipt || state.expiredObservation || intent.planId !== planId || state.recoveryBlocked) throw new Error('migration_explicit_confirmation_required');
      // Verify that another page has not replaced or cleared this exact local selector.
      if (!await metadata(intent, fresh => fresh)) return;
      await dispatch(intent, accept);
    }, true),
    acknowledge: () => perform(async () => {
      const intent = state.pending;
      if (!intent || !state.receipt || !sameReceipt(intent, state.receipt)) return;
      if (!await metadata(intent, fresh => ({ version: 2, pending: null, history: historyWith(fresh, { kind: 'acknowledged', requestId: intent.requestId }) }))) return;
      publish({ receipt: null, checked: false, inspectedRequestId: null, expiredObservation: null });
    }),
    archiveExpired: confirmed => perform(async () => {
      const intent = state.pending;
      if (!confirmed || !intent || intent.planId !== planId || state.receipt || !state.checked || state.inspectedRequestId !== intent.requestId || !state.expiredObservation) throw new Error('migration_explicit_confirmation_required');
      const row = expiredBudgetHistoryRow(intent, { jobId, requestId: intent.requestId }, state.view, validView);
      if (!row) throw new Error('migration_explicit_confirmation_required');
      if (!await metadata(intent, fresh => ({ version: 2, pending: null, history: historyWith(fresh, row) }))) return;
      publish({ receipt: null, checked: false, inspectedRequestId: null, expiredObservation: null });
    }),
  };
}
