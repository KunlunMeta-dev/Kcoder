import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readStorageJson, validateStorageLocationRecord, validateStorageOperationId } from './storage-paths.mjs';
import { validateStorageMigrationReceipt } from './storage-startup.mjs';
import { activeComponentDirectoryScopes, copyBinding } from './storage-component-publication-scope.mjs';
import { assertStorageActiveOperationOutsideRoots } from './storage-active-operation.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const CONTROL = 'kcoder-storage.lock';
const roles = new Set(['native', 'gateway', 'desktop']);
const markerKeys = ['version', 'operationId', 'role', 'sourceRoot', 'sourceIdentity', 'targetRoot',
  'selectionRevision', 'controlDirectory', 'controlIdentity'];

function path(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || /[\0\r\n]/.test(value) ||
      Buffer.byteLength(value) > 32767) fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  return value;
}

function planPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  return path(normalize(value));
}

function mapping(plan, role) {
  const source = planPath(role === 'native' ? plan.from.dataRoot : role === 'gateway' ? plan.from.gatewayRoot : plan.from.desktopRoot);
  const target = planPath(role === 'native' ? plan.target.dataRoot : join(planPath(plan.target.dataRoot), 'studio', role));
  if (source === target) return null;
  const moved = plan.components.some(component => {
    const declaredSource = planPath(component.source), declaredTarget = planPath(component.destination);
    const local = relative(declaredSource, source);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local) &&
      declaredSource !== declaredTarget && join(declaredTarget, local) === target;
  });
  return moved ? { source, target } : null;
}

function markerRecord(value, role, rootIdentity) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== markerKeys.length ||
      !markerKeys.every(key => Object.hasOwn(value, key)) || value.version !== 1 || value.role !== role ||
      value.sourceIdentity !== rootIdentity || typeof value.controlIdentity !== 'string' || !value.controlIdentity ||
      value.controlIdentity.length > 256 || !Number.isSafeInteger(value.selectionRevision) || value.selectionRevision < 1)
    fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  try { validateStorageOperationId(value.operationId); } catch { fail('STORAGE_SOURCE_RETIREMENT_INVALID'); }
  path(value.sourceRoot); path(value.targetRoot);
  if (basename(path(value.controlDirectory)) !== '.config') fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  return value;
}

async function originalOperation(marker) {
  const operation = join(marker.controlDirectory, 'kcoder-storage-migrations', marker.operationId);
  for (const directory of [join(marker.controlDirectory, 'kcoder-storage-migrations'), operation]) {
    const entry = await lstat(directory).catch(() => fail('STORAGE_SOURCE_RETIREMENT_UNAVAILABLE'));
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  }
  const receipt = await readStorageJson(join(operation, 'receipt.json'), { limit: 1024 * 1024,
    invalid: 'STORAGE_SOURCE_RETIREMENT_INVALID', unavailable: 'STORAGE_SOURCE_RETIREMENT_UNAVAILABLE' });
  if (receipt === undefined) fail('STORAGE_SOURCE_RETIREMENT_UNAVAILABLE');
  await validateStorageMigrationReceipt(receipt, marker.operationId);
  if (receipt.plan.operationId !== marker.operationId ||
      receipt.plan.target.operationId !== marker.operationId || receipt.plan.target.revision !== marker.selectionRevision)
    fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  return receipt;
}

/** The original WRITERS lease remains held. No marker means no personal
 * locator/archive read; this path never changes an explicit Home's selection. */
export async function assertStorageRootAdmitted({ native, lease, role }) {
  if (!roles.has(role)) fail('STORAGE_SOURCE_RETIREMENT_INVALID');
  native.verify(lease);
  const observed = JSON.parse(native.readSourceRetirement(lease, role));
  if (observed.marker === null) return assertStorageTargetAdmitted({ native, lease });
  let parsed;
  try { parsed = JSON.parse(observed.marker.text); } catch { fail('STORAGE_SOURCE_RETIREMENT_INVALID'); }
  const marker = markerRecord(parsed, role, observed.rootIdentity);
  const gate = native.trySharedExisting(marker.controlDirectory, CONTROL);
  if (gate === null) fail('STORAGE_MIGRATION_PENDING');
  if (gate === undefined) fail('STORAGE_SOURCE_RETIREMENT_UNAVAILABLE');
  try {
    const control = JSON.parse(native.readSourceRetirement(gate, 'control'));
    if (control.rootIdentity !== marker.controlIdentity) fail('STORAGE_SOURCE_RETIREMENT_CHANGED');
    const receipt = await originalOperation(marker);
    const proof = receipt.ownerReceipts?.[`source-retirement-${role}`];
    if (!proof || proof.version !== 1 || proof.cleaned !== false || !isDeepStrictEqual(proof.marker, marker) ||
        proof.markerIdentity !== observed.marker.identity ||
        proof.markerSha256 !== createHash('sha256').update(observed.marker.text).digest('hex'))
      fail('STORAGE_SOURCE_RETIREMENT_UNCONFIRMED');
    const moved = mapping(receipt.plan, role);
    if (!moved || moved.source !== marker.sourceRoot || moved.target !== marker.targetRoot)
      fail('STORAGE_SOURCE_RETIREMENT_INVALID');
    for (const component of receipt.plan.components) {
      if (planPath(component.source) === marker.sourceRoot && component.sourceIdentity !== marker.sourceIdentity)
        fail('STORAGE_SOURCE_RETIREMENT_CHANGED');
    }
    native.verify(gate); native.verify(lease);
    if (receipt.disposition === 'complete' && receipt.phase === 'verified' && receipt.errorCode == null)
      fail('STORAGE_SOURCE_RETIRED');
    if (receipt.disposition === 'active' && receipt.phase !== 'verified') fail('STORAGE_MIGRATION_PENDING');
    fail('STORAGE_SOURCE_RETIREMENT_UNCONFIRMED');
  } finally { native.close(gate); }
}

/** A component-local backlink keeps an unfinished published tree closed after
 * its executor exits. It observes only the original bounded publication facts. */
export async function assertStorageTargetAdmitted({ native, lease }) {
  let gate, target, originalTarget;
  try {
    native.verify(lease);
    const observed = JSON.parse(native.readSourceRetirement(lease, 'pending'));
    if (observed.marker === null) return;
    const marker = JSON.parse(observed.marker.text);
    const keys = ['version', 'operationId', 'domain', 'rootIdentity', 'controlDirectory', 'controlIdentity'];
    if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).length !== keys.length ||
        !keys.every(key => Object.hasOwn(marker, key)) || marker.version !== 1 || marker.rootIdentity !== observed.rootIdentity ||
        typeof marker.domain !== 'string' || marker.domain.length > 64 || !/^[a-z0-9-]+$/.test(marker.domain) ||
        typeof marker.controlIdentity !== 'string' || !marker.controlIdentity || marker.controlIdentity.length > 256 ||
        basename(path(marker.controlDirectory)) !== '.config') fail('STORAGE_MIGRATION_PENDING');
    validateStorageOperationId(marker.operationId);
    gate = native.trySharedExisting(marker.controlDirectory, CONTROL);
    if (gate === null || gate === undefined) fail('STORAGE_MIGRATION_PENDING');
    const original = JSON.parse(native.readSourceRetirement(gate, `operation:${marker.operationId}`));
    if (original.rootIdentity !== marker.controlIdentity || !original.receipt) fail('STORAGE_MIGRATION_PENDING');
    const receipt = JSON.parse(original.receipt.text);
    await validateStorageMigrationReceipt(receipt, marker.operationId);
    const components = receipt.plan.components.filter(part => part.domain === marker.domain);
    const intent = receipt.ownerReceipts?.[`publish-${marker.domain}`];
    const owned = receipt.ownerReceipts?.[`pending-${marker.domain}`];
    if (components.length !== 1 || !owned || Object.keys(owned).length !== 1 || owned.identity !== observed.marker.identity ||
        Buffer.byteLength(`pending-${marker.domain}`) > 64) fail('STORAGE_MIGRATION_PENDING');
    const scopes = activeComponentDirectoryScopes(receipt);
    const inPlace = planPath(components[0].source) === planPath(components[0].destination);
    if (inPlace) {
      const root = planPath(components[0].source);
      if (components[0].sourceIdentity !== marker.rootIdentity || root !== planPath(receipt.plan.from.dataRoot) ||
          root !== planPath(receipt.plan.target.dataRoot)) fail('STORAGE_MIGRATION_PENDING');
      for (const binding of receipt.plan.targetBindings) {
        if (planPath(binding.path) === root && (planPath(binding.existingAncestor) !== root || binding.ancestorIdentity !== marker.rootIdentity))
          fail('STORAGE_MIGRATION_PENDING');
      }
    } else if (!intent || intent.operationDirectoryIdentity !== original.operationIdentity ||
        scopes.get(planPath(components[0].destination)) !== marker.rootIdentity ||
        !copyBinding(receipt.ownerReceipts?.[`copy-${marker.domain}`], intent) ||
        intent.container && !isDeepStrictEqual(intent.container.publishedCopy, receipt.ownerReceipts[`copy-${marker.domain}`]))
      fail('STORAGE_MIGRATION_PENDING');
    if (receipt.disposition !== 'complete' || receipt.phase !== 'verified' || receipt.errorCode != null || !original.selection)
      fail('STORAGE_MIGRATION_PENDING');
    const selected = JSON.parse(original.selection.text);
    validateStorageLocationRecord(selected);
    if (selected.operationId === marker.operationId) {
      if (!isDeepStrictEqual(selected, receipt.plan.target)) fail('STORAGE_MIGRATION_PENDING');
    } else {
      validateStorageOperationId(selected.operationId);
      const current = JSON.parse(native.readSourceRetirement(gate, `operation:${selected.operationId}`));
      if (!current.receipt || current.rootIdentity !== marker.controlIdentity) fail('STORAGE_MIGRATION_PENDING');
      const direct = JSON.parse(current.receipt.text);
      await validateStorageMigrationReceipt(direct, selected.operationId);
      if (direct.disposition !== 'complete' || direct.phase !== 'verified' || direct.errorCode != null ||
          !isDeepStrictEqual(direct.plan.target, selected)) fail('STORAGE_MIGRATION_PENDING');
    }
    const destination = planPath(components[0].destination);
    const local = relative(planPath(receipt.plan.target.dataRoot), destination);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) fail('STORAGE_MIGRATION_PENDING');
    target = native.trySharedExisting(join(planPath(selected.dataRoot), local), 'kcoder-storage-writers.lock');
    if (target === null || target === undefined ||
        JSON.parse(native.readSourceRetirement(target, 'identity')).rootIdentity !== marker.rootIdentity)
      fail('STORAGE_MIGRATION_PENDING');
    if (join(planPath(selected.dataRoot), local) !== destination) {
      originalTarget = native.trySharedExisting(destination, 'kcoder-storage-writers.lock');
      if (!originalTarget || JSON.parse(native.readSourceRetirement(originalTarget, 'identity')).rootIdentity !== marker.rootIdentity)
        fail('STORAGE_MIGRATION_PENDING');
    }
    await assertStorageActiveOperationOutsideRoots({ home: dirname(marker.controlDirectory), native,
      rootLeases: new Map([[destination, target]]) });
    native.verify(gate); native.verify(lease); native.verify(target);
    if (!isDeepStrictEqual(JSON.parse(native.readSourceRetirement(lease, 'pending')), observed) ||
        !isDeepStrictEqual(JSON.parse(native.readSourceRetirement(gate, `operation:${marker.operationId}`)), original))
      fail('STORAGE_MIGRATION_PENDING');
  } catch { fail('STORAGE_MIGRATION_PENDING'); }
  finally { if (originalTarget) native.close(originalTarget); if (target) native.close(target); if (gate) native.close(gate); }
}
