import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStorageStartupReady } from './storage-startup.mjs';
import { assertStorageRootAdmitted, assertStorageTargetAdmitted } from './storage-source-retirement.mjs';
import { assertStorageActiveOperationOutsideRoots } from './storage-active-operation.mjs';
import { resolveStorageRuntimeResources } from './storage-runtime-resources.mjs';
import { isDeepStrictEqual } from 'node:util';

const CONTROL = 'kcoder-storage.lock';
const INSTANCES = 'kcoder-storage-instances.lock';
const WRITERS = 'kcoder-storage-writers.lock';
const fail = code => { throw Object.assign(new Error(code), { code }); };
let loadedNative;

function deferredPlanMatches(receipt, expected) {
  return receipt?.disposition === 'deferred' && expected?.disposition === 'deferred' &&
    isDeepStrictEqual(receipt.plan, expected.plan);
}

function verifyDeferredHeldRoots(native, receipt, rootLeases) {
  if (!receipt) return;
  for (const component of receipt.plan.components) {
    const lease = rootLeases.get(component.source);
    if (!lease) continue;
    const observed = JSON.parse(native.readSourceRetirement(lease, 'identity'));
    if (observed.rootIdentity !== component.sourceIdentity) fail('STORAGE_SOURCE_CHANGED');
  }
}

/** Only the selected checkout build or its exact installed resource path may supply native code. */
export async function loadStorageNative() {
  loadedNative ??= (async () => {
    const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
    const resources = await resolveStorageRuntimeResources({
      moduleUrl: import.meta.url, applicationRoot, resourcesPath: process.resourcesPath,
    });
    const source = resources.layout === 'source';
    const library = process.platform === 'win32' ? 'kcoder_native_storage.dll'
      : process.platform === 'darwin' ? 'libkcoder_native_storage.dylib' : 'libkcoder_native_storage.so';
    const path = source ? resolve(resources.repositoryRoot,
      process.env.KCODER_TARGET_DIR || process.env.CARGO_TARGET_DIR || 'target', 'debug', library)
      : resources.nativeAddonPath;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(path, flags)
      .catch(() => fail('STORAGE_NATIVE_RESOURCE_UNAVAILABLE'));
    try {
      const original = await handle.stat({ bigint: true });
      const sameOpened = (left, right) => right.isFile() && left.dev === right.dev && left.ino === right.ino &&
        left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
      const sameNamed = (named, opened) => named.isFile() && !named.isSymbolicLink() &&
        named.ino === opened.ino && named.nlink === opened.nlink && named.size === opened.size &&
        named.mtimeNs === opened.mtimeNs && named.ctimeNs === opened.ctimeNs &&
        (named.dev === opened.dev || process.platform === 'win32' && named.dev === 0n);
      if (!original.isFile() || original.size > 64n * 1024n * 1024n ||
        original.nlink !== 1n && !(source && original.nlink === 2n)) fail('STORAGE_NATIVE_RESOURCE_INVALID');
      // Cargo publishes a cdylib as two links inside this checkout's target.
      // This code-image convention does not relax any private lock-file rule.
      const names = original.nlink === 2n ? [path, join(dirname(path), 'deps', library)] : [path];
      const verifyImage = async () => {
        if (!sameOpened(original, await handle.stat({ bigint: true }))) fail('STORAGE_NATIVE_RESOURCE_INVALID');
        for (const name of names) {
          if (!sameNamed(await lstat(name, { bigint: true }), original)) fail('STORAGE_NATIVE_RESOURCE_INVALID');
          const named = await open(name, flags);
          try {
            // A Windows path stat can report dev=0. Reopen its current name to
            // require the actual volume and complete file index of the held FD.
            const current = await named.stat({ bigint: true });
            if (!sameOpened(original, current) || !sameNamed(await lstat(name, { bigint: true }), current)) {
              fail('STORAGE_NATIVE_RESOURCE_INVALID');
            }
          } finally { await named.close(); }
        }
      };
      await verifyImage();
      const module = { exports: {} };
      process.dlopen(module, path);
      await verifyImage();
      const native = module.exports;
      if (native.abiVersion !== 1 || !['tryShared', 'tryExclusive', 'trySharedExisting', 'verify', 'close', 'readSourceRetirement']
        .every(name => typeof native[name] === 'function')) fail('STORAGE_NATIVE_RESOURCE_INVALID');
      return native;
    } finally { await handle.close(); }
  })();
  return loadedNative;
}

/** Hold real OS leases until this host actually stops; no PID or authorization cache. */
export async function acquireStorageInstance(selected, { native, consumer = selected.context.consumer } = {}) {
  native ??= await loadStorageNative();
  const { context, paths } = selected;
  const held = [];
  let gate;
  const take = (root, name, create, code) => {
    const lease = native.tryShared(root, name, create);
    if (lease === null) fail(code);
    held.push(lease);
    return lease;
  };
  const verify = () => { for (const lease of held) native.verify(lease); };
  const close = () => { while (held.length) native.close(held.pop()); };
  const probeChild = root => {
    const lease = native.trySharedExisting(root, INSTANCES);
    if (lease === null) fail('STORAGE_MIGRATION_BUSY');
    if (lease !== undefined) {
      try { native.verify(lease); } finally { native.close(lease); }
    }
  };
  try {
    if (!context.development && !context.overrides.KCODER_HOME && !context.overrides.KCODER_CONFIG_DIR) {
      gate = take(join(context.home, '.config'), CONTROL, true, 'STORAGE_MIGRATION_BUSY');
    }
    const startupReceipt = await assertStorageStartupReady(selected);
    if (((startupReceipt?.disposition === 'deferred' && startupReceipt.plan?.from?.layout === 'legacy') ||
      selected.deferredReceipt?.plan?.from?.layout === 'legacy') &&
      !deferredPlanMatches(startupReceipt, selected.deferredReceipt)) {
      fail('STORAGE_SELECTION_CHANGED');
    }
    if (gate) take(join(context.home, '.config'), INSTANCES, false, 'STORAGE_MIGRATION_BUSY');
    const roots = new Set([paths.dataRoot, paths.cacheRoot]);
    const rootLeases = new Map();
    if (consumer === 'gateway' || consumer === 'desktop') roots.add(paths.gatewayRoot);
    if (consumer === 'desktop') roots.add(paths.desktopRoot);
    const ancestors = new Set();
    for (const root of roots) {
      for (let parent = dirname(resolve(root)); ; parent = dirname(parent)) {
        if (!roots.has(parent)) ancestors.add(parent);
        if (dirname(parent) === parent) break;
      }
    }
    const ancestorLease = async ancestor => {
      const lease = native.trySharedExisting(ancestor, WRITERS);
      if (lease === null) fail('STORAGE_MIGRATION_BUSY');
      if (lease === undefined) return;
      try { probeChild(ancestor); await assertStorageTargetAdmitted({ native, lease }); return lease; }
      catch (error) { native.close(lease); throw error; }
    };
    // Existing pending parents are observed before creating a missing profile.
    // Reacquisition after own registration remains necessary for migration races.
    for (const ancestor of ancestors) {
      const lease = await ancestorLease(ancestor);
      if (lease) native.close(lease);
    }
    // Register every own root before rewalking ancestor fences. A coordinator
    // takes the parent exclusively before scanning already-registered children.
    for (const root of roots) {
      rootLeases.set(root, take(root, WRITERS, !(paths.selectionRevision !== null && root === paths.dataRoot), 'STORAGE_MIGRATION_BUSY'));
      probeChild(root);
    }
    for (const ancestor of ancestors) {
      const lease = await ancestorLease(ancestor);
      if (lease) held.push(lease);
    }
    verify();
    verifyDeferredHeldRoots(native, selected.deferredReceipt, rootLeases);
    const rootRoles = [[paths.dataRoot, 'native']];
    if (consumer === 'gateway' || consumer === 'desktop') rootRoles.push([paths.gatewayRoot, 'gateway']);
    if (consumer === 'desktop') rootRoles.push([paths.desktopRoot, 'desktop']);
    for (const [root, role] of rootRoles) await assertStorageRootAdmitted({ native, lease: rootLeases.get(root), role });
    await assertStorageTargetAdmitted({ native, lease: rootLeases.get(paths.cacheRoot) });
    if (context.development || context.overrides.KCODER_HOME || context.overrides.KCODER_CONFIG_DIR) {
      await assertStorageActiveOperationOutsideRoots({ home: context.home, native, rootLeases });
    }
    verify();
    if (gate) {
      native.close(gate);
      held.splice(held.indexOf(gate), 1);
      gate = null;
    }
    let closed = false;
    return Object.freeze({
      verify() { if (closed) fail('STORAGE_INSTANCE_CLOSED'); verify(); },
      close() { if (!closed) { close(); closed = true; } },
    });
  } catch (error) { close(); throw error; }
}
