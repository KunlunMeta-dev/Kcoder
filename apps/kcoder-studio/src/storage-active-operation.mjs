import { isAbsolute, normalize, relative, sep } from 'node:path';
import { activeComponentDirectoryScopes } from './storage-component-publication-scope.mjs';
import { readStorageMigration } from './storage-startup.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const WRITERS = 'kcoder-storage-writers.lock';
const path = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > 32767 || /[\0\r\n]/.test(value)) fail('STORAGE_PATH_INVALID');
  return normalize(value);
};
const within = (parent, child) => {
  const local = relative(parent, child);
  return local === '' || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
};
const intersects = (left, right) => within(left, right) || within(right, left);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

function facts(native, lease) {
  native.verify(lease);
  const observed = JSON.parse(native.readSourceRetirement(lease, 'identity'));
  if (!identity(observed.rootIdentity) || !Array.isArray(observed.ancestorIdentities) ||
      !observed.ancestorIdentities.every(identity) || !observed.ancestorIdentities.includes(observed.rootIdentity))
    fail('STORAGE_ROOT_CHANGED');
  return observed;
}

/** The original writer leases are already held. This only refuses Active
 * scopes; it never chooses paths, changes the locator or authorizes an owner.
 * Corrupt global operation metadata also blocks explicit profiles: unknown
 * scope cannot be guessed unrelated. A valid unrelated operation is allowed. */
export async function assertStorageActiveOperationOutsideRoots({ home, native, rootLeases }) {
  const receipt = await readStorageMigration(home, { requireCurrent: true });
  if (!receipt || receipt.disposition !== 'active') return;
  const plan = receipt.plan, published = activeComponentDirectoryScopes(receipt);
  const scopes = new Set([plan.from.dataRoot, plan.from.cacheRoot, plan.from.gatewayRoot, plan.from.desktopRoot,
    plan.target.dataRoot, plan.target.cacheRoot, ...plan.components.flatMap(part => [part.source, part.destination]),
    ...published.keys()].map(path));
  for (const own of rootLeases.keys()) {
    if ([...scopes].some(scope => intersects(path(own), scope))) fail('STORAGE_MIGRATION_PENDING');
  }
  const ownIds = new Set(), ownAncestors = new Set();
  for (const lease of rootLeases.values()) {
    const observed = facts(native, lease);
    ownIds.add(observed.rootIdentity);
    for (const id of observed.ancestorIdentities) ownAncestors.add(id);
  }
  const frozen = new Set([...plan.components.map(part => part.sourceIdentity), ...published.values()]);
  for (const binding of plan.targetBindings ?? []) {
    if (path(binding.path) === path(binding.existingAncestor)) frozen.add(binding.ancestorIdentity);
  }
  if ([...frozen].some(id => ownAncestors.has(id))) fail('STORAGE_MIGRATION_PENDING');
  for (const scope of scopes) {
    // Existing-only observation supplies aliases while preserving the primary
    // plan/publication scopes when its real fence is still busy or absent.
    const lease = native.trySharedExisting(scope, WRITERS);
    if (lease === null || lease === undefined) continue;
    try {
      const observed = facts(native, lease);
      if (ownAncestors.has(observed.rootIdentity) || observed.ancestorIdentities.some(id => ownIds.has(id))) fail('STORAGE_MIGRATION_PENDING');
    } finally { native.close(lease); }
  }
  for (const lease of rootLeases.values()) native.verify(lease);
}
