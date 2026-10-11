import { windowsPrivateDeviceStorage } from "./mobile-device-private-storage.js";
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, realpath, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => validSecret(a) && validSecret(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRotation = value => typeof value === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(value);
const pairingWindowMs = 7 * 24 * 60 * 60_000;
// OS environment credentials cannot contain NUL. Keep existing nonempty-token
// store identities, while placing the stable no-auth mode in a disjoint domain.
// The private .key isolates different installations.
export function mobileDeviceStoreIdentity(authToken) {
  if (typeof authToken !== 'string' || authToken.includes('\0')) throw new Error('Invalid mobile authorization configuration');
  return authToken || '\0kcoder.mobile-device-auth.no-auth.v1';
}
export class MobileDeviceAuthError extends Error {
  constructor(message = 'Mobile device authorization rejected', status = 401) { super(message); this.status = status; }
}

/** Private Gateway-owned hash store. No refresh/access plaintext is persisted. */
export function createMobileDeviceAuth({ directory, identity, accessTtlMs = 15 * 60_000, idleTtlMs = 0, absoluteTtlMs = 0, socketGraceMs = 5 * 60_000, maximumDevices = 128, now = Date.now }) {
  // Zero means no time-based expiry. Keep a finite, safe wire/store value so
  // existing clients can compare expiry without JSON Infinity becoming null.
  const deadline = (time, ttl) => ttl === 0 ? Number.MAX_SAFE_INTEGER : Math.min(Number.MAX_SAFE_INTEGER, time + ttl);
  if (![accessTtlMs, idleTtlMs, absoluteTtlMs, socketGraceMs].every(value => Number.isSafeInteger(value) && value >= 0) || accessTtlMs < 100 || (idleTtlMs !== 0 && idleTtlMs < accessTtlMs) || (absoluteTtlMs !== 0 && (idleTtlMs === 0 || absoluteTtlMs < idleTtlMs)))
    throw new Error('Invalid mobile authorization lifetime');
  const root = resolve(directory, 'mobile-device-auth');
  const filePath = resolve(root, 'devices.json'); const keyPath = resolve(root, '.key');
  const identityHash = hash(identity);
  let tail = Promise.resolve();
  const privateInfo = async path => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Unsafe mobile authorization storage');
    return info;
  };
  const readPrivate = async (path, maximum) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Unsafe mobile authorization file');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  };
  const transaction = operation => {
    const result = tail.catch(() => {}).then(async () => {
      const created = await mkdir(root, { recursive: true, mode: 0o700 }); await privateInfo(root);
      let storageIdentity;
      if (process.platform === 'win32') storageIdentity = await windowsPrivateDeviceStorage(root, Boolean(created));
      else {
        const filesystem = await statfs(root);
        if ([0x6969, 0x517b, 0xff534d42].includes(filesystem.type)) throw new Error('Shared network mobile device storage is unsupported');
        const info = await lstat(root); storageIdentity = `local-file:${info.dev}:${info.ino}`;
      }
      // A loopback bind is a cross-platform kernel mutex for this local store.
      // Process death releases it without stale-file or PID-reuse recovery.
      // Port collisions serialize unrelated stores; they never admit two owners.
      const lockPort = 49152 + (parseInt(hash(storageIdentity).slice(0, 8), 16) % 16384);
      const locker = createServer(socket => socket.destroy());
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          await new Promise((done, reject) => {
            const failed = error => { locker.off('listening', listening); reject(error); };
            const listening = () => { locker.off('error', failed); done(); };
            locker.once('error', failed); locker.once('listening', listening);
            locker.listen({ host: '127.0.0.1', port: lockPort, exclusive: true });
          });
          break;
        } catch (error) {
          if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) throw new MobileDeviceAuthError('Device authorization local store lock unavailable', 503);
          await new Promise(done => setTimeout(done, 25));
        }
      }
      try {
        let data; let hasStore = true;
        try { data = JSON.parse(await readPrivate(filePath, 1048576)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; hasStore = false; data = { version: 1, identityHash, devices: [] }; }
        if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > maximumDevices || !validSecret(data.identityHash) || data.devices.some(device => !device || !validRotation(device.id) || !validRotation(device.authEpoch) || typeof device.label !== 'string' || device.label.length > 80 || !Number.isSafeInteger(device.generation) || device.generation < 0 || !validSecret(device.currentHash) || (device.previousHash !== null && !validSecret(device.previousHash)) || !validRotation(device.lastRotationId) || !['createdAt', 'lastUsedAt', 'expiresAt', 'absoluteExpiresAt', 'accessExpiresAt'].every(field => Number.isSafeInteger(device[field]) && device[field] >= 0))) throw new Error('Invalid mobile authorization store');
        let key;
        try { const rawKey = await readPrivate(keyPath, 128); if (!validSecret(rawKey)) throw new Error('Invalid mobile authorization key'); key = Buffer.from(rawKey, 'hex'); }
        catch (error) {
          if (error.code !== 'ENOENT' || hasStore) throw new Error('Mobile authorization key unavailable');
          key = randomBytes(32); const handle = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(key.toString('hex')); await handle.sync(); } finally { await handle.close(); }
        }
        if (key.length !== 32) throw new Error('Invalid mobile authorization key');
        if (data.identityHash !== identityHash) { data = { version: 1, identityHash, devices: [] }; }
        const result = await operation(data, key);
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, filePath);
          if (process.platform !== 'win32') { const parent = await open(root, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return result;
      } finally { await new Promise(done => locker.close(done)); }
    });
    tail = result;
    return result;
  };
  const derive = (key, purpose, ...values) => createHmac('sha256', key).update(JSON.stringify([purpose, ...values])).digest('hex');
  const pairingCredential = (data, key) => {
    const window = Math.floor(now() / pairingWindowMs);
    const generation = Number.isSafeInteger(data.pairingGeneration) && data.pairingGeneration >= 0 ? data.pairingGeneration : 0;
    return {
      token: derive(key, 'mobile-pairing.v1', data.identityHash, window, generation),
      expiresAt: Math.min(Number.MAX_SAFE_INTEGER, (window + 1) * pairingWindowMs),
    };
  };
  const response = (device, key, refreshToken) => ({
    accessToken: derive(key, 'access', device.id, device.generation, device.lastRotationId), expiresAt: device.accessExpiresAt,
    accessTtlMs, refreshToken, refreshExpiresAt: device.expiresAt, deviceId: device.id, authorizationGeneration: device.authEpoch,
    // Configuration credential rotation may revoke devices, but cannot change
    // the installation namespace or claim another installation's old scope.
    retentionNamespaceId: derive(key, 'kcoder.retention.gateway-namespace.v1'),
    stableLoginOwner: `mobile-device:${device.id}`, wsLeaseExpiresAt: Math.min(device.expiresAt, device.absoluteExpiresAt, device.accessExpiresAt + socketGraceMs),
    capabilities: { mobileRefreshV1: true, mobileDeviceManagementV1: true },
  });
  const validDevice = device => !device.revoked && device.expiresAt > now() && device.absoluteExpiresAt > now();
  return {
    getPairingCredential() { return transaction(async (data, key) => pairingCredential(data, key)); },
    rotatePairingCredential() { return transaction(async (data, key) => {
      const generation = Number.isSafeInteger(data.pairingGeneration) && data.pairingGeneration >= 0 ? data.pairingGeneration : 0;
      if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('Mobile pairing credential generation exhausted');
      data.pairingGeneration = generation + 1;
      return pairingCredential(data, key);
    }); },
    matchesPairingCredential(value) { return transaction(async (data, key) => {
      if (!validSecret(value)) return false;
      return equal(value, pairingCredential(data, key).token);
    }); },
    pair(label = 'Mobile device') { return transaction(async (data, key) => {
      data.devices = data.devices.filter(validDevice);
      if (data.devices.length >= maximumDevices) throw new MobileDeviceAuthError('Device limit reached', 429);
      const refreshToken = randomBytes(32).toString('hex'); const time = now();
      const absoluteExpiresAt = deadline(time, absoluteTtlMs);
      const device = { id: randomUUID(), label: String(label).slice(0, 80), authEpoch: randomUUID(), generation: 0, currentHash: hash(refreshToken), previousHash: null, lastRotationId: randomUUID(), createdAt: time, lastUsedAt: time, expiresAt: Math.min(deadline(time, idleTtlMs), absoluteExpiresAt), absoluteExpiresAt, accessExpiresAt: deadline(time, accessTtlMs) };
      data.devices.push(device); return response(device, key, refreshToken);
    }); },
    refresh(refreshToken, rotationId) { return transaction(async (data, key) => {
      if (!validSecret(refreshToken) || !validRotation(rotationId)) throw new MobileDeviceAuthError();
      const digest = hash(refreshToken);
      const device = data.devices.find(item => equal(item.currentHash, digest) || equal(item.previousHash, digest));
      if (!device || !validDevice(device)) throw new MobileDeviceAuthError();
      if (device.lastRotationId === rotationId && device.previousHash && (equal(device.previousHash, digest) || equal(device.currentHash, digest))) {
        return response(device, key, derive(key, 'refresh', device.id, device.previousHash, rotationId));
      }
      if (!equal(device.currentHash, digest)) throw new MobileDeviceAuthError('Conflicting rotation', 409);
      const next = derive(key, 'refresh', device.id, digest, rotationId);
      device.previousHash = digest; device.currentHash = hash(next); device.lastRotationId = rotationId; device.generation++; device.lastUsedAt = now();
      if (absoluteTtlMs === 0) device.absoluteExpiresAt = Number.MAX_SAFE_INTEGER;
      device.expiresAt = Math.min(deadline(now(), idleTtlMs), device.absoluteExpiresAt); device.accessExpiresAt = Math.min(deadline(now(), accessTtlMs), device.expiresAt);
      return response(device, key, next);
    }); },
    list() { return transaction(async data => data.devices.filter(validDevice).map(({ id, label, createdAt, lastUsedAt, expiresAt }) => ({ id, label, createdAt, lastUsedAt, expiresAt }))); },
    revoke(id) { return transaction(async data => { const device = data.devices.find(item => item.id === id); if (device) device.revoked = true; return Boolean(device); }); },
  };
}
