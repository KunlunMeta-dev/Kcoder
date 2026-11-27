import { loadStorageContext } from '../storage-paths.mjs';
import { assertDeferredStorageRoots, assertStorageStartupReady, readStorageMigration } from '../storage-startup.mjs';
import { isDeepStrictEqual } from 'node:util';

function verified(completed) {
  if (completed?.disposition === 'deferred') {
    if (typeof completed.plan?.operationId !== 'string' || !Object.hasOwn(completed.plan, 'original') ||
      !['legacy', 'unified', 'custom'].includes(completed.plan.from?.layout)) {
      throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
    }
    return;
  }
  if (!completed || completed.phase !== 'verified' || completed.disposition !== 'complete') {
    throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  }
}

function projectDeferredStorageRoots(selected, receipt) {
  const { context, paths } = selected;
  const plan = receipt?.plan;
  if (receipt?.disposition !== 'deferred' || plan?.from?.layout !== 'legacy' ||
    plan.from.externallyConfigured !== false || !isDeepStrictEqual(plan.original, context.record) ||
    context.development || Object.keys(context.overrides).length !== 0 ||
    paths.layout !== 'legacy' || paths.externallyConfigured || paths.operationId !== null) {
    throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  }
  return { ...selected, paths: plan.from, deferredReceipt: receipt };
}

function sameDeferredPlan(left, right) {
  return left?.disposition === 'deferred' && right?.disposition === 'deferred' &&
    isDeepStrictEqual(left.plan, right.plan);
}

async function reloadAfterStartup(client, load, loadOptions, expectedReceipt) {
  const completed = await client.startup();
  if (completed !== null) verified(completed);
  if (expectedReceipt && !sameDeferredPlan(completed, expectedReceipt)) {
    throw Object.assign(new Error('STORAGE_SELECTION_CHANGED'), { code: 'STORAGE_SELECTION_CHANGED' });
  }
  let selected = await load(loadOptions);
  if (completed?.disposition === 'deferred' && completed.plan?.from?.layout === 'legacy') {
    selected = projectDeferredStorageRoots(selected, completed);
  }
  const receipt = await assertStorageStartupReady(selected);
  if (completed?.disposition === 'deferred' && !sameDeferredPlan(completed, receipt)) {
    throw Object.assign(new Error('STORAGE_SELECTION_CHANGED'), { code: 'STORAGE_SELECTION_CHANGED' });
  }
  if (receipt?.disposition === 'deferred' && receipt.plan?.from?.layout === 'legacy' &&
    completed?.disposition !== 'deferred') {
    throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  }
  if (!selected.context.development && !selected.paths.externallyConfigured &&
    receipt?.disposition !== 'deferred' && selected.paths.layout !== 'unified') {
    throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  }
  return selected;
}

/** A real business entry may use the existing Native startup coordinator to
 * resolve a pending storage transaction. Pure loaders remain read-only. */
export async function loadStorageBusinessContext({ load = loadStorageContext, loadOptions, createClient }) {
  return load(loadOptions);
}

/** Host startup only. Pure path/status queries never call the one-shot worker.
 * The original native coordinator serializes recovery and admits business only
 * after its verifier settles. A failed worker is not permission to use old paths. */
export async function prepareStorageBusinessStartup({ selected, load = loadStorageContext, loadOptions,
  readOperation = readStorageMigration, createClient }) {
  selected ??= await loadStorageBusinessContext({ load, loadOptions, createClient });
  if (selected.context.development || selected.paths.externallyConfigured) return selected;
  const receipt = await readOperation(selected.context.home);
  if (receipt?.disposition === 'deferred') {
    if (receipt.plan?.from?.layout !== 'legacy' || selected.paths.layout !== 'legacy') {
      assertDeferredStorageRoots(selected, receipt);
      return selected;
    }
    if (!createClient) {
      throw Object.assign(new Error('STORAGE_STARTUP_UNCONFIRMED'), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
    }
    return reloadAfterStartup(await createClient(selected), load, loadOptions, receipt);
  }
  if (selected.paths.layout === 'unified' && receipt?.disposition !== 'active') return selected;
  const client = await createClient(selected);
  // Read the committed revision again before any session, writer, or child
  // receives a frozen context. Never reset an already-running business context.
  return reloadAfterStartup(client, load, loadOptions);
}
