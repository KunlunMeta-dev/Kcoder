import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { matchesSchema } from '../shared/generated/validator.mjs';
import { readStorageJson, readStorageLocationRecord, storageLocationFile, validateStorageOperationId,
  validateStorageLocationRecord } from './storage-paths.mjs';

const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }); };
const migrationSchemaUrl = new URL('../shared/generated/storage-migration.schema.json', import.meta.url);
let migrationSchemaPromise;
const sameSelection = (left, right) => left == null || right == null ? left == null && right == null
  : left.version === right.version && left.revision === right.revision && left.dataRoot === right.dataRoot &&
    left.cacheRoot === right.cacheRoot && (left.operationId ?? null) === (right.operationId ?? null);

function directoryChain(target) {
  if (!isAbsolute(target)) fail('STORAGE_PATH_INVALID');
  const chain = [];
  let current = resolve(target);
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

async function checkDirectoryChain(target, { invalid, missingAllowed = false }) {
  const chain = directoryChain(target);
  for (const path of chain) {
    let entry;
    try { entry = await lstat(path); }
    catch (error) {
      if (missingAllowed && error.code === 'ENOENT') return false;
      fail(invalid, error);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail(invalid);
  }
  return true;
}

async function migrationReceiptSchema() {
  try {
    migrationSchemaPromise ??= readFile(migrationSchemaUrl, 'utf8').then(JSON.parse);
    return await migrationSchemaPromise;
  } catch {
    fail('STORAGE_CONTROL_UNAVAILABLE');
  }
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > 32767 || /[\0\r\n]/.test(value)) {
    fail('STORAGE_PATH_INVALID');
  }
  return normalize(value);
}

function planPathMatches(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isPathWithin(parent, child) {
  const relativePath = relative(normalizedPath(parent), normalizedPath(child));
  return relativePath === '' || relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function checkPlan(plan, id) {
  try { validateStorageOperationId(plan.operationId); }
  catch { fail('STORAGE_OPERATION_INVALID'); }
  if (plan.version !== 1) fail('STORAGE_RECORD_VERSION_UNSUPPORTED');
  if (plan.operationId !== id) fail('STORAGE_OPERATION_INVALID');
  if (plan.original != null) validateStorageLocationRecord(plan.original);
  validateStorageLocationRecord(plan.target);
  if (plan.from.externallyConfigured) fail('STORAGE_EXTERNAL_INSTANCE_READ_ONLY');
  if ((plan.from.selectionRevision ?? null) !== (plan.original?.revision ?? null)) fail('STORAGE_OPERATION_INVALID');
  if (plan.original && (!planPathMatches(plan.from.dataRoot, plan.original.dataRoot) ||
    !planPathMatches(plan.from.cacheRoot, plan.original.cacheRoot))) fail('STORAGE_OPERATION_INVALID');

  for (const component of plan.components) {
    normalizedPath(component.source);
    normalizedPath(component.destination);
    if (Buffer.byteLength(component.sourceIdentity) < 1 || Buffer.byteLength(component.sourceIdentity) > 256 ||
      Buffer.byteLength(component.domain) < 1 || Buffer.byteLength(component.domain) > 64 ||
      !/^[a-z0-9-]+$/.test(component.domain)) fail('STORAGE_OPERATION_INVALID');
  }
  const bindings = plan.targetBindings ?? [];
  if (bindings.length > 2) fail('STORAGE_OPERATION_INVALID');
  const targetRoots = [plan.target.dataRoot, plan.target.cacheRoot].map(normalizedPath);
  for (const binding of bindings) {
    const targetPath = normalizedPath(binding.path), ancestor = normalizedPath(binding.existingAncestor);
    if (!targetRoots.includes(targetPath) || !isPathWithin(ancestor, targetPath) ||
      Buffer.byteLength(binding.ancestorIdentity) < 1 || Buffer.byteLength(binding.ancestorIdentity) > 256) {
      fail('STORAGE_OPERATION_INVALID');
    }
  }
  const priorRevision = plan.original?.revision ?? 0;
  if (priorRevision >= Number.MAX_SAFE_INTEGER || plan.target.revision !== priorRevision + 1 ||
    plan.target.operationId !== plan.operationId) fail('STORAGE_OPERATION_INVALID');
}

function checkReceipt(receipt, id, schema, { allowActive = false } = {}) {
  if (!matchesSchema(schema, receipt)) {
    const compatible = structuredClone(receipt);
    let unsupportedLocationVersion = false;
    for (const record of [compatible?.plan?.original, compatible?.plan?.target]) {
      if (!record || !Number.isInteger(record.version) || record.version < 0 || record.version > 0xffffffff || record.version === 1) continue;
      record.version = 1;
      unsupportedLocationVersion = true;
    }
    if (!unsupportedLocationVersion || !matchesSchema(schema, compatible)) fail('STORAGE_CONTROL_INVALID');
    fail('STORAGE_RECORD_VERSION_UNSUPPORTED');
  }
  checkPlan(receipt.plan, id);
  for (const [domain, value] of Object.entries(receipt.ownerReceipts ?? {})) {
    const bytes = Buffer.byteLength(domain);
    if (bytes < 1 || bytes > 64 || !/^[a-z0-9-]+$/.test(domain) ||
      value === null || typeof value !== 'object' || Array.isArray(value)) fail('STORAGE_CONTROL_INVALID');
  }
  const precommit = ['planned', 'stopping', 'stopped', 'copying', 'verifying', 'prepared'];
  if (receipt.disposition === 'active' && receipt.phase !== 'verified') {
    if (allowActive) return false;
    fail('STORAGE_MIGRATION_PENDING');
  }
  const complete = receipt.disposition === 'complete' && receipt.phase === 'verified' && receipt.errorCode == null;
  const deferred = receipt.disposition === 'deferred' && precommit.includes(receipt.phase) &&
    typeof receipt.errorCode === 'string' && receipt.errorCode.length > 0;
  if (!complete && !deferred) fail('STORAGE_CONTROL_INVALID');
  return complete;
}

/** Validate one explicitly named archive without consulting the current locator. */
export async function validateStorageMigrationReceipt(receipt, id) {
  return checkReceipt(receipt, id, await migrationReceiptSchema());
}

/** Read only the bounded global operation metadata. No selection lookup,
 * directory creation, permission repair or historical scan belongs here. */
export async function readStorageMigration(home, { requireCurrent = false } = {}) {
  await checkDirectoryChain(home, { invalid: 'STORAGE_CONTROL_UNAVAILABLE' });
  if (!await checkDirectoryChain(join(home, '.config'), { invalid: 'STORAGE_CONTROL_UNAVAILABLE', missingAllowed: true })) return undefined;
  const controls = join(home, '.config', 'kcoder-storage-migrations');
  if (!await checkDirectoryChain(controls, { invalid: 'STORAGE_CONTROL_INVALID', missingAllowed: true })) return undefined;
  const read = (file, limit) => readStorageJson(file, { limit, invalid: 'STORAGE_CONTROL_INVALID', unavailable: 'STORAGE_CONTROL_UNAVAILABLE' });
  const id = await read(join(controls, 'current.json'), 1024);
  if (id === undefined) {
    if (requireCurrent) fail('STORAGE_OPERATION_MISSING');
    return undefined;
  }
  if (typeof id !== 'string') fail('STORAGE_CONTROL_INVALID');
  try { validateStorageOperationId(id); } catch { fail('STORAGE_OPERATION_INVALID'); }
  const operation = join(controls, id);
  if (!await checkDirectoryChain(operation, { invalid: 'STORAGE_CONTROL_INVALID', missingAllowed: true })) fail('STORAGE_OPERATION_MISSING');
  const receipt = await read(join(operation, 'receipt.json'), 1024 * 1024);
  if (receipt === undefined) fail('STORAGE_OPERATION_MISSING');
  checkReceipt(receipt, id, await migrationReceiptSchema(), { allowActive: true });
  return receipt;
}

/** A deferred operation cannot authorize opening unrelated default roots. */
export function assertDeferredStorageRoots({ paths }, receipt) {
  if (receipt?.disposition === 'deferred' && ['dataRoot', 'cacheRoot', 'gatewayRoot', 'desktopRoot']
    .some(name => !planPathMatches(paths[name], receipt.plan.from[name]))) fail('STORAGE_SELECTION_CHANGED');
}

/** Read-only startup refusal. Lifetime writer fencing is a separate Native admission step. */
export async function assertStorageStartupReady({ context, paths }) {
  const externalHome = context.development || context.overrides.KCODER_HOME || context.overrides.KCODER_CONFIG_DIR;
  let receipt;
  if (!externalHome) {
    receipt = await readStorageMigration(context.home);
    const selected = await readStorageLocationRecord(storageLocationFile(context.home));
    if (!sameSelection(selected, context.record)) fail('STORAGE_SELECTION_CHANGED');
    if (receipt === undefined) {
      if (selected?.operationId) fail('STORAGE_OPERATION_MISSING');
    } else {
      if (receipt.disposition === 'active') fail('STORAGE_MIGRATION_PENDING');
      const complete = receipt.disposition === 'complete';
      if (!sameSelection(selected, complete ? receipt.plan.target : receipt.plan.original)) fail('STORAGE_SELECTION_CHANGED');
      assertDeferredStorageRoots({ paths }, receipt);
    }
  }
  if (paths.selectionRevision !== null) {
    const root = await lstat(paths.dataRoot).catch(error => fail('STORAGE_DATA_ROOT_UNAVAILABLE', error));
    if (!root.isDirectory() || root.isSymbolicLink()) fail('STORAGE_DATA_ROOT_UNAVAILABLE');
  }
  return receipt;
}
