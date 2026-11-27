import { readSync, writeSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { loadStorageNative } from '../storage-lease.mjs';

export const OFFLINE_OWNER_FRAME_LIMIT = 1024 * 1024;
const INSTANCES = 'kcoder-storage-instances.lock';
const failure = code => Object.assign(new Error(code), { code });

/** Synchronous callbacks are required by the SQLite owners. Keep these private
 * descriptors separate from Node streams so there is exactly one reader. */
export function createOfflineOwnerProtocol(input = 0, output = 1) {
  let buffered = Buffer.alloc(0);
  const read = () => {
    while (true) {
      const newline = buffered.indexOf(10);
      if (newline !== -1) {
        if (newline >= OFFLINE_OWNER_FRAME_LIMIT) throw failure('STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE');
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        let frame;
        try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { throw failure('STORAGE_OFFLINE_CHILD_FRAME_INVALID'); }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw failure('STORAGE_OFFLINE_CHILD_FRAME_INVALID');
        return frame;
      }
      if (buffered.length >= OFFLINE_OWNER_FRAME_LIMIT) throw failure('STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE');
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, OFFLINE_OWNER_FRAME_LIMIT - buffered.length));
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) throw failure('STORAGE_OFFLINE_PARENT_UNAVAILABLE');
      buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
    }
  };
  const write = frame => {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > OFFLINE_OWNER_FRAME_LIMIT) throw failure('STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE');
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(output, bytes, offset, bytes.length - offset);
      if (!count) throw failure('STORAGE_OFFLINE_PARENT_UNAVAILABLE');
      offset += count;
    }
  };
  return Object.freeze({ read, write });
}

function initialize(frame) {
  if (frame.type !== 'initialize' || frame.version !== 1 || typeof frame.operationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(frame.operationId) || !Array.isArray(frame.roots) || !frame.roots.length)
    throw failure('STORAGE_OFFLINE_CHILD_FRAME_INVALID');
  const seen = new Set();
  for (const fact of frame.roots) {
    if (!fact || typeof fact !== 'object' || typeof fact.root !== 'string' || !isAbsolute(fact.root) ||
        resolve(fact.root) !== fact.root || seen.has(fact.root) ||
        !['directoryIdentity', 'primaryIdentity', 'secondaryIdentity'].every(key =>
          typeof fact[key] === 'string' && fact[key].length > 0 && fact[key].length <= 2048))
      throw failure('STORAGE_OFFLINE_CHILD_FRAME_INVALID');
    seen.add(fact.root);
  }
  return frame;
}

/** The injected dispatcher owns domain authorization and Native scope checks.
 * Initialization only prepares kernel control leaves; no owner is opened until
 * all independent child locks and the final live parent check have succeeded. */
export async function runOfflineOwnerChild({ run, native, protocol = createOfflineOwnerProtocol() } = {}) {
  if (typeof run !== 'function') throw failure('STORAGE_OFFLINE_CHILD_DISPATCH_REQUIRED');
  const request = initialize(protocol.read());
  native ??= await loadStorageNative();
  const held = [];
  // Do not close on a result or pipe EOF. A still-running asynchronous owner
  // must remain fenced after its parent dies, through this process's teardown.
  process.once('exit', () => held);
  let sequence = 0;
  const validate = (type, facts) => {
    for (const lease of held) native.verify(lease);
    const current = ++sequence;
    protocol.write({ type, version: 1, sequence: current, operationId: request.operationId, facts });
    const response = protocol.read();
    if (response.type !== 'validated' || response.version !== 1 || response.sequence !== current ||
        response.operationId !== request.operationId) throw failure('STORAGE_OFFLINE_PARENT_REJECTED');
    for (const lease of held) native.verify(lease);
    return true;
  };
  const validateFences = () => validate('validateFences', request.roots);
  validateFences();
  for (const { root } of request.roots) {
    // Parent already created the leaf under its exclusive primary. Never create
    // a source root or substitute another data location to obtain this lock.
    const lease = native.tryExclusive(root, INSTANCES, false);
    if (!lease) throw failure('STORAGE_WRITERS_ACTIVE');
    held.push(lease);
    native.verify(lease);
  }
  validateFences();
  protocol.write({ type: 'ready', version: 1, operationId: request.operationId });
  validateFences();
  const validateOffline = facts => {
    if (!facts || facts.operationId !== request.operationId) throw failure('STORAGE_OFFLINE_PARENT_REJECTED');
    return validate('validateOffline', facts);
  };
  const observeStorageEntry = (path, kind) => {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path ||
        !['directory', 'file'].includes(kind) || typeof native.observeEntry !== 'function')
      throw failure('STORAGE_OFFLINE_METADATA_INVALID');
    const candidates = request.roots.map((fact, index) => ({ root: fact.root, lease: held[index], local: relative(
      process.platform === 'win32' ? toNamespacedPath(fact.root) : fact.root,
      process.platform === 'win32' ? toNamespacedPath(path) : path) }))
      .filter(({ local }) => local && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local))
      .sort((left, right) => left.local.length - right.local.length);
    if (!candidates.length) throw failure('STORAGE_OFFLINE_METADATA_INVALID');
    const { lease, local } = candidates[0];
    const facts = JSON.parse(native.observeEntry(lease, local, kind));
    if (!facts || Object.keys(facts).length !== 2 || typeof facts.identity !== 'string' ||
        !facts.identity.length || facts.identity.length > 2048 ||
        (kind === 'directory' ? facts.links !== null : typeof facts.links !== 'string' || !/^[1-9][0-9]{0,19}$/.test(facts.links)))
      throw failure('STORAGE_OFFLINE_METADATA_INVALID');
    return facts;
  };
  const value = await run(request.payload, Object.freeze({ operationId: request.operationId, validateOffline, observeStorageEntry }));
  validateFences();
  protocol.write({ type: 'completed', version: 1, operationId: request.operationId, value });
  return value;
}
