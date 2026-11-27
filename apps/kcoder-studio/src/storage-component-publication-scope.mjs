import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateStorageOperationId } from './storage-paths.mjs';

// Owned with Config's component_publication.rs. These are refusal scopes only;
// callers first validate the original receipt/plan and retain their native gates.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('STORAGE_COMPONENT_RECEIPT_CONFLICT');
const requiredIntent = ['version', 'operationId', 'domain', 'sourceIdentity', 'destination',
  'operationDirectoryIdentity', 'targetParentIdentity', 'stagingName', 'stagingIdentity'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unsigned = (value, bits) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 1n << BigInt(bits);

function directoryIdentity(value) {
  if (!text(value)) return false;
  const [platform, ...parts] = value.split(':');
  return platform === 'unix' && parts.length === 2 && parts.every(part => unsigned(part, 64)) ||
    platform === 'windows' && parts.length === 3 && parts.every(part => unsigned(part, 32));
}

function path(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !isAbsolute(value) ||
    Buffer.byteLength(value) > 32767 || /[\0\r\n]/.test(value)) invalid();
  return resolve(value);
}

function within(parent, child) {
  const local = relative(parent, child);
  return local === '' || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function fenceIdentity(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (!fields(parsed, ['version', 'kind', 'native']) || parsed.version !== 1 ||
    !['regularFile', 'directory'].includes(parsed.kind) || !object(parsed.native)) return false;
  const native = parsed.native;
  const number = value => Number.isInteger(value) && value >= 0 && value < 2 ** 64;
  if (['linux', 'unix'].includes(native.platform)) return fields(native, ['platform', 'device', 'inode']) &&
    number(native.device) && number(native.inode);
  return native.platform === 'windows' && fields(native, ['platform', 'volumeSerialNumber', 'fileId']) &&
    number(native.volumeSerialNumber) && Array.isArray(native.fileId) && native.fileId.length === 16 &&
    native.fileId.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

export function copyBinding(binding, intent) {
  if (!fields(binding, ['version', 'scope', 'authorizedVersions'], ['pendingAppend']) ||
    ![1, 2].includes(binding.version)) return false;
  const scope = binding.scope;
  if (!fields(scope, ['operationId', 'domain', 'operationDirectoryIdentity', 'sourceRootIdentity',
    'stagingRootIdentity', 'inventorySha256']) || scope.operationId !== intent.operationId ||
    scope.domain !== intent.domain || scope.operationDirectoryIdentity !== intent.operationDirectoryIdentity ||
    scope.sourceRootIdentity !== intent.sourceIdentity || scope.stagingRootIdentity !== intent.stagingIdentity ||
    !hash(scope.inventorySha256) || !Array.isArray(binding.authorizedVersions) ||
    binding.authorizedVersions.length < 1 || binding.authorizedVersions.length > 2) return false;
  const versions = binding.authorizedVersions;
  if (!versions.every(version => fields(version, ['identity', 'sha256', 'sizeBytes']) && text(version.identity) &&
    hash(version.sha256) && Number.isSafeInteger(version.sizeBytes) && version.sizeBytes >= 0 &&
    version.sizeBytes <= (binding.version === 2 ? 256 : 64) * 1024 * 1024)) return false;
  if (binding.pendingAppend == null) return binding.version === 1 || versions.length === 1;
  const pending = binding.pendingAppend;
  return binding.version === 2 && versions.length === 2 && fields(pending, ['offset', 'frame']) &&
    typeof pending.frame === 'string' && pending.frame.isWellFormed() && Buffer.byteLength(pending.frame) <= 2048 &&
    pending.frame.endsWith('\n') && versions[0].identity === versions[1].identity &&
    versions[0].sizeBytes === pending.offset && versions[1].sizeBytes === pending.offset + Buffer.byteLength(pending.frame);
}

/** Synchronous metadata projection of the original small publication receipts.
 * No filesystem reads, manifest hashing, directory creation or admission authority.
 * Paths catch nested roots; native ancestor IDs also catch renamed/aliased roots.
 * Incomplete publication checkpoints still refuse writers. */
export function activeComponentDirectoryScopes(receipt) {
  const plan = receipt?.plan;
  if (!object(plan) || !Array.isArray(plan.components) || plan.version !== 1) invalid();
  try { validateStorageOperationId(plan.operationId); } catch { invalid(); }
  const scopes = new Map();
  for (const [key, intent] of Object.entries(receipt.ownerReceipts ?? {})) {
    if (!key.startsWith('publish-')) continue;
    const domain = key.slice('publish-'.length);
    if (Buffer.byteLength(key) > 64 || !/^[a-z0-9-]+$/.test(domain) ||
      !fields(intent, requiredIntent, ['container'])) invalid();
    if (Buffer.byteLength(JSON.stringify(intent)) > 256 * 1024) fail('STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED');
    if (![1, 2].includes(intent.version)) fail('STORAGE_COMPONENT_VERSION_UNSUPPORTED');
    const components = plan.components.filter(component => component.domain === domain);
    if (components.length !== 1) invalid();
    const component = components[0], source = path(component.source), destination = path(component.destination);
    if (intent.operationId !== plan.operationId || intent.domain !== domain ||
      intent.sourceIdentity !== component.sourceIdentity || intent.destination !== destination ||
      within(source, destination) || within(destination, source) ||
      ![intent.sourceIdentity, intent.operationDirectoryIdentity, intent.targetParentIdentity, intent.stagingIdentity]
        .every(directoryIdentity) || [intent.sourceIdentity, intent.operationDirectoryIdentity, intent.targetParentIdentity]
        .includes(intent.stagingIdentity) || intent.targetParentIdentity === intent.operationDirectoryIdentity) invalid();
    const paths = [destination];
    if (intent.container != null) {
      const container = intent.container;
      if (intent.version !== 2 || intent.stagingName !== '' ||
        !fields(container, ['fences'], ['publishedCopy']) || !Array.isArray(container.fences) || !container.fences.length ||
        destination !== path(plan.target.dataRoot) || !(plan.targetBindings ?? []).some(binding =>
          path(binding.path) === destination && path(binding.existingAncestor) === destination &&
          binding.ancestorIdentity === intent.stagingIdentity)) invalid();
      const names = new Set();
      for (const fence of container.fences) {
        if (!fields(fence, ['name', 'identity']) || typeof fence.name !== 'string' || !fence.name ||
          fence.name.length > 255 || /[^\x00-\x7f]|[\/\\\0]/.test(fence.name) ||
          ['.', '..'].includes(fence.name) || names.has(fence.name) || typeof fence.identity !== 'string' ||
          !fenceIdentity(fence.identity)) invalid();
        names.add(fence.name);
      }
      if (container.publishedCopy != null && !copyBinding(container.publishedCopy, intent)) invalid();
    } else {
      let stage = `.kcoder-storage-${plan.operationId}-${domain}`;
      const destinationAsciiCase = basename(destination).replace(/[A-Z]/g, letter => letter.toLowerCase());
      if (stage.toLowerCase() === destinationAsciiCase) stage += '.staging';
      if (intent.version !== 1 || intent.stagingName !== stage) invalid();
      paths.push(join(dirname(destination), stage));
    }
    for (const target of paths) {
      if (scopes.has(target) && scopes.get(target) !== intent.stagingIdentity) invalid();
      scopes.set(target, intent.stagingIdentity);
    }
  }
  return scopes;
}
