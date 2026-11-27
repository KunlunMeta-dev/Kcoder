const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));
const limitsEqual = (a, b) => ['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'].every(key => a?.[key] === b?.[key]);
const same = (a, b) => !!a && !!b && ['jobId', 'planId', 'expectedSequence', 'confirm'].every(key => a[key] === b[key]) && limitsEqual(a.limits, b.limits);

/** Local state is only an owned recovery selector; the Native intent is authoritative. */
export function createResourceAttachmentController({ api, storage, scope, kind, jobId, isCurrent, validView, validIntent }) {
  const key = `kcoder.migration.resource-budget.v1:attachment:${scope}:${kind}:${jobId}`, listeners = new Set();
  let active = true, epoch = 0, state = { busy: false, view: null, pending: null, error: null, checked: false, recoveryBlocked: false };
  const current = () => { try { return active && isCurrent(); } catch { return false; } };
  const emit = patch => { if (!current()) return; state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const load = local => {
    const text = local.getItem(key);
    if (text === null) return null;
    if (text.length > 4096) throw Error('attachment_recovery_unavailable');
    const value = JSON.parse(text);
    if (value?.version !== 1 || Object.keys(value).length !== 2 || !validIntent(value.intent) || value.intent.jobId !== jobId) throw Error('attachment_recovery_unavailable');
    return value.intent;
  };
  const intentFrom = view => view.originalIntent ? { jobId, expectedSequence: view.originalIntent.expectedSequence, limits: clone(view.originalIntent.initialLimits), confirm: true,
    ...(kind === 'batch' ? { planId: view.originalIntent.planId } : {}) } : null;
  const metadata = async (expected, change) => {
    const ticket = epoch;
    try {
      const result = await storage.withTransaction(key, local => {
        if (!current() || epoch !== ticket) throw Error('attachment_scope_changed');
        const before = load(local);
        if (before !== null && !same(before, expected) || expected !== null && before === null) return { saved: false, pending: before };
        const next = change(before), text = JSON.stringify({ version: 1, intent: next });
        if (!validIntent(next) || text.length > 4096) throw Error('attachment_recovery_unavailable');
        if (!current() || epoch !== ticket) throw Error('attachment_scope_changed');
        local.setItem(key, text);
        if (local.getItem(key) !== text) throw Error('attachment_recovery_unavailable');
        return { saved: true, pending: next };
      });
      if (!current() || epoch !== ticket) return false;
      emit({ pending: clone(result.pending), ...(!result.saved ? { error: 'attachment_intent_changed' } : {}) });
      return result.saved;
    } catch { emit({ error: 'attachment_recovery_unavailable', recoveryBlocked: true }); return false; }
  };
  const observe = async accept => {
    const view = await api.read({ jobId });
    if (!accept()) return null;
    if (!validView({ jobId }, view)) throw Error('attachment_invalid_response');
    const original = intentFrom(view);
    if (state.pending && original && !same(state.pending, original)) throw Error('attachment_intent_changed');
    emit({ view: clone(view), checked: true });
    return view;
  };
  const perform = async action => {
    if (!current() || state.busy) return;
    const ticket = ++epoch; emit({ busy: true, error: null });
    const accept = () => current() && epoch === ticket;
    try { await action(accept); }
    catch (error) { if (accept()) emit({ checked: false, error: ['migration_resource_budget_update_required', 'migration_update_required'].includes(error?.message) ? 'attachment_update_required' : ['attachment_invalid_response', 'attachment_intent_changed', 'attachment_confirmation_required', 'attachment_recovery_unavailable', 'attachment_update_required'].includes(error?.message) ? error.message : 'attachment_outcome_unknown' }); }
    finally { if (accept()) emit({ busy: false }); }
  };
  const dispatch = async (intent, accept) => {
    if (!accept()) return;
    await api.attach(clone(intent));
    if (!accept()) return;
    await observe(accept);
  };
  return {
    getSnapshot: () => state, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    activate() { active = true; state = { ...state, busy: false }; }, dispose() { active = false; epoch++; storage.close?.(); listeners.clear(); },
    read: () => perform(async accept => {
      try { await storage.refresh(key); if (!accept()) return; emit({ pending: clone(load(storage)) }); }
      catch { emit({ error: 'attachment_recovery_unavailable', recoveryBlocked: true }); }
      await observe(accept);
    }),
    bind: (limits, confirmed) => perform(async accept => {
      if (!confirmed || state.pending || state.recoveryBlocked) throw Error('attachment_confirmation_required');
      const original = state.view;
      const fresh = await observe(accept);
      if (!fresh || fresh.phase !== 'untracked' || fresh.ownerJobId !== jobId || !original
        || fresh.currentSequence !== original.currentSequence || fresh.currentPlanId !== original.currentPlanId) throw Error('attachment_intent_changed');
      const intent = { jobId, expectedSequence: fresh.currentSequence, limits: clone(limits), confirm: true,
        ...(kind === 'batch' ? { planId: fresh.currentPlanId } : {}) };
      if (!validIntent(intent)) throw Error('attachment_confirmation_required');
      if (await metadata(null, () => intent) && accept()) await dispatch(intent, accept);
    }),
    resume: confirmed => perform(async accept => {
      if (!confirmed || state.recoveryBlocked) throw Error('attachment_confirmation_required');
      const previous = state.view, fresh = await observe(accept);
      if (!fresh || !previous) throw Error('attachment_intent_changed');
      let original = intentFrom(fresh);
      if (fresh.phase === 'pending') {
        if (!same(intentFrom(previous), original)) throw Error('attachment_intent_changed');
      } else if (fresh.phase === 'untracked' && previous.phase === 'untracked' && state.pending
        && fresh.ownerJobId === jobId && fresh.currentSequence === state.pending.expectedSequence
        && (kind === 'history' || fresh.currentPlanId === state.pending.planId)) original = state.pending;
      else throw Error('attachment_intent_changed');
      if (!original || !validIntent(original) || state.pending && !same(state.pending, original)) throw Error('attachment_intent_changed');
      if (await metadata(state.pending, () => original) && accept()) await dispatch(original, accept);
    }),
  };
}
