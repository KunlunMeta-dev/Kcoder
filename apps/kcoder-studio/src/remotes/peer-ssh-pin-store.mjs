import { constants, lstatSync } from 'node:fs';
import { mkdir, open, lstat, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { windowsPrivateDeviceStorage } from '../gateway-device-private-storage.js';
import { writePrivateFile } from '../../../kcoder-channel-host/src/jsonc-file.mjs';
import { isPeerSshEnrollmentV1 } from '../../shared/generated/contractGuards.peer-ssh.mjs';
import { signGatewayPeerSshProof, orderedPeerSshEnrollment, verifyNativePeerSshProof } from './peer-ssh-facts.mjs';

const maximumBytes = 1024 * 1024;
const fail = (code, unknown = false) => Object.assign(new Error(code), { code, ...(unknown ? { externalOutcome: 'unknown' } : {}) });
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathInfo = async path => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw fail('PEER_SSH_PRIVATE_STORAGE_UNSAFE');
  return info;
};
const rootIdentity = info => `${info.dev}:${info.ino}`;
const fileVersion = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].map(String).join(':');
const authorities = new WeakMap();
export function requirePeerSshPinAuthority(selection) {
  const value = authorities.get(selection);
  if (!value) throw fail('AGENT_MESSAGES_SSH_PIN_AUTHORITY_REQUIRED');
  return value;
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

async function readPrivate(path, limit, observed) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw fail('PEER_SSH_PRIVATE_STORAGE_UNSAFE');
    const bytes = await file.readFile(); const after = await file.stat(); const named = await pathInfo(path);
    if (bytes.length > limit || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino)
      throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
    observed?.(fileVersion(await file.stat({ bigint: true })));
    return bytes;
  } finally { await file.close(); }
}
async function acquireMutex(identity) {
  const port = 49152 + parseInt(digest(identity).slice(0, 8), 16) % 16384;
  const listener = createServer(socket => socket.destroy());
  const deadline = Date.now() + 1000;
  while (true) {
    try {
      await new Promise((done, reject) => {
        const error = cause => { listener.off('listening', ready); reject(cause); };
        const ready = () => { listener.off('error', error); done(); };
        listener.once('error', error); listener.once('listening', ready);
        listener.listen({ host: '127.0.0.1', port, exclusive: true });
      });
      return () => new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) throw fail('PEER_SSH_PRIVATE_STORAGE_BUSY');
      await new Promise(done => setTimeout(done, 25));
    }
  }
}
function validLedger(value) {
  return object(value) && Object.keys(value).sort().join(',') === 'gateway,pins,proposals,revision,version' && value.version === 1 &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && object(value.gateway) &&
    typeof value.gateway.gatewayId === 'string' && /^[a-f0-9]{64}$/.test(value.gateway.gatewayId) &&
    value.gateway.keyGeneration === 1 && Array.isArray(value.gateway.publicKey) && value.gateway.publicKey.length === 32 &&
    Array.isArray(value.pins) && value.pins.length <= 128 && value.pins.every(row => object(row) &&
      typeof row.scopeKey === 'string' && ['pinned', 'revoking', 'revoked', 'setup_unconfirmed'].includes(row.status) && isPeerSshEnrollmentV1(row.enrollment)) &&
    Array.isArray(value.proposals) && value.proposals.length <= 128 && value.proposals.every(row => object(row) &&
      typeof row.id === 'string' && typeof row.digest === 'string' && typeof row.operationId === 'string' &&
      ['proposed', 'dispatching', 'setup_unconfirmed', 'completed', 'discarded'].includes(row.phase));
}

/** Dedicated namespace and key. It never reads the Mobile device ledger/key.
 * The fixed leaf names reuse the existing Windows handle identity guard.
 */
export function createPeerSshPinStore({ directory, windowsGuard = windowsPrivateDeviceStorage, publish = writePrivateFile } = {}) {
  const root = resolve(directory, 'peer-ssh-enrollment-v1');
  const ledgerPath = join(root, 'devices.json'), keyPath = join(root, '.key');
  let identity, closed = false, tail = Promise.resolve(), current, currentVersions;
  const checkRoot = async initialize => {
    if (closed) throw fail('PEER_SSH_PRIVATE_STORAGE_CLOSED');
    let created;
    try { await lstat(root); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (identity) throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
      if (!initialize) return null;
      created = await mkdir(root, { recursive: true });
    }
    const info = await pathInfo(root);
    if (!info.isDirectory()) throw fail('PEER_SSH_PRIVATE_STORAGE_UNSAFE');
    const observed = rootIdentity(info);
    if (identity && identity !== observed) throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
    let mutexIdentity;
    if (process.platform === 'win32') mutexIdentity = await windowsGuard(root, Boolean(created));
    else {
      const filesystem = await statfs(root);
      if ([0x6969, 0x517b, 0xff534d42].includes(filesystem.type)) throw fail('PEER_SSH_PRIVATE_STORAGE_UNSAFE');
      mutexIdentity = `local-file:${observed}`;
    }
    identity ??= observed;
    return { mutexIdentity, created: Boolean(created) };
  };
  const transact = (initialize, action, write = false, verifyBeforeAction) => {
    const operation = tail.then(async () => {
      const loadedRoot = await checkRoot(initialize);
      if (!loadedRoot) return null;
      const release = await acquireMutex(loadedRoot.mutexIdentity);
      let published = false;
      const versions = {};
      try {
        if (rootIdentity(await pathInfo(root)) !== identity) throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
        let raw; try { raw = await readPrivate(ledgerPath, maximumBytes, value => { versions.ledger = value; }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!raw && !loadedRoot.created) throw fail('PEER_SSH_PRIVATE_LEDGER_MISSING', true);
        if (!raw && !initialize) { current = undefined; return null; }
        let key;
        try { key = (await readPrivate(keyPath, 128, value => { versions.key = value; })).toString('ascii'); }
        catch (error) {
          if (error.code !== 'ENOENT' || raw || !initialize) throw fail('PEER_SSH_PRIVATE_KEY_UNAVAILABLE');
          key = randomBytes(32).toString('hex');
          const file = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
          try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
          await readPrivate(keyPath, 128, value => { versions.key = value; });
        }
        if (!/^[a-f0-9]{64}$/.test(key)) throw fail('PEER_SSH_PRIVATE_KEY_UNAVAILABLE');
        const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'pkcs8' });
        const publicKey = [...createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)];
        const gateway = { gatewayId: digest(Buffer.from(publicKey)), publicKey, keyGeneration: 1 };
        const data = raw ? JSON.parse(raw.toString('utf8')) : { version: 1, gateway, revision: 0, pins: [], proposals: [] };
        if (!validLedger(data) || !isDeepStrictEqual(data.gateway, gateway)) throw fail('PEER_SSH_PRIVATE_LEDGER_INVALID');
        await verifyBeforeAction?.();
        if (rootIdentity(await pathInfo(root)) !== identity || closed) throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
        const before = JSON.stringify(data);
        const result = action(data, privateKey);
        if (result instanceof Promise) throw fail('PEER_SSH_PRIVATE_TRANSACTION_ASYNC');
        const after = JSON.stringify(data);
        if (!validLedger(data) || Buffer.byteLength(after) > maximumBytes) throw fail('PEER_SSH_PRIVATE_LEDGER_INVALID');
        if (after !== before || !raw) {
          if (!write) throw fail('PEER_SSH_PRIVATE_TRANSACTION_READ_ONLY');
          data.revision++;
          published = true;
          if (closed) throw fail('PEER_SSH_PRIVATE_STORAGE_CLOSED');
          const intended = Buffer.from(JSON.stringify(data));
          await publish(ledgerPath, intended);
          const actual = await readPrivate(ledgerPath, maximumBytes, value => { versions.ledger = value; });
          if (!actual.equals(intended)) throw fail('PEER_SSH_PRIVATE_STORAGE_CHANGED');
        }
        current = structuredClone(data);
        currentVersions = versions;
        return result;
      } catch (error) {
        if (published) throw fail('PEER_SSH_PRIVATE_PUBLISH_UNCONFIRMED', true);
        throw error;
      } finally { await release(); }
    }).then(async result => {
      // Recheck the held directory identity after the transaction on Windows.
      if (identity && process.platform === 'win32') await checkRoot(false);
      return result;
    });
    tail = operation.catch(() => { current = undefined; currentVersions = undefined; });
    return operation;
  };
  return Object.freeze({
    initialize: () => transact(true, data => structuredClone(data.gateway), true),
    read: () => transact(false, data => structuredClone(data)),
    update: (action, verifyBeforeAction) => transact(true, data => action(data), true, verifyBeforeAction),
    async selection(scopeKey, verifyScope) {
      const data = await transact(false, data => structuredClone(data));
      const pin = data?.pins.find(row => row.scopeKey === scopeKey && row.status === 'pinned');
      if (!pin) return null;
      const expected = frozen(orderedPeerSshEnrollment(pin.enrollment));
      const assertCurrent = () => {
        verifyScope();
        let unchanged = false;
        try {
          const rootNow = lstatSync(root, { bigint: true });
          const keyNow = lstatSync(keyPath, { bigint: true }), ledgerNow = lstatSync(ledgerPath, { bigint: true });
          unchanged = rootNow.isDirectory() && !rootNow.isSymbolicLink() && rootIdentity(rootNow) === identity &&
            !keyNow.isSymbolicLink() && !ledgerNow.isSymbolicLink() && currentVersions &&
            fileVersion(keyNow) === currentVersions.key && fileVersion(ledgerNow) === currentVersions.ledger;
        } catch {}
        if (!unchanged)
          throw fail('PEER_SSH_PIN_REVALIDATION_REQUIRED');
        if (closed || !current?.pins.some(row => row.scopeKey === scopeKey && row.status === 'pinned' && isDeepStrictEqual(row.enrollment, expected)))
          throw fail('PEER_SSH_PIN_CHANGED');
      };
      const revalidate = async () => { await transact(false, () => null); assertCurrent(); };
      assertCurrent();
      const selection = Object.freeze({});
      authorities.set(selection, Object.freeze({ expected, assertCurrent, revalidate,
        signNativeProof: proof => transact(false, (data, key) => {
          verifyScope();
          if (!data.pins.some(row => row.scopeKey === scopeKey && row.status === 'pinned' && isDeepStrictEqual(row.enrollment, expected))) throw fail('PEER_SSH_PIN_CHANGED');
          if (!isDeepStrictEqual(proof?.claims?.enrollment, expected)) throw fail('PEER_SSH_PIN_CHANGED');
          verifyNativePeerSshProof(proof, proof.claims);
          return signGatewayPeerSshProof(proof, key);
        }) }));
      return selection;
    },
    async close() { closed = true; current = undefined; await tail; },
  });
}
