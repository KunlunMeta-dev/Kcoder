import { windowsPrivateDeviceStorage } from "./mobile-device-private-storage.js";
import { createBrowserSessionPersistence, createBrowserSessionOperationQueue } from './browser-session-recovery.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, realpath, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash, createHmac, createPrivateKey, createPublicKey, sign as cryptoSign, timingSafeEqual } from 'node:crypto';
import { validLocalRetentionRoute, validRevocationStatement, revocationRequest } from './retention-device-revocation.js';
import { canonicalGatewayConnectionUrl, connectionProofMessage, isLoopbackGatewayConnectionUrl } from '../shared/gatewayConnectionRoutes.js';
import { peerAnswerSignatureMessage, peerOfferProofMessage } from '../shared/gatewayPeerTransport.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => validSecret(a) && validSecret(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRotation = value => typeof value === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(value);
const pairingWindowMs = 7 * 24 * 60 * 60_000;
const maximumRevocationFacts = 512;
const maximumRetentionRoutes = 1024;
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
export function createMobileDeviceAuth({ directory, identity, fixedPairingToken = '', accessTtlMs = 15 * 60_000, idleTtlMs = 0, absoluteTtlMs = 0, socketGraceMs = 5 * 60_000, maximumDevices = 128, now = Date.now, isConnectionEndpointAllowed = () => false }) {
  // Zero means no time-based expiry. Keep a finite, safe wire/store value so
  // existing clients can compare expiry without JSON Infinity becoming null.
  const deadline = (time, ttl) => ttl === 0 ? Number.MAX_SAFE_INTEGER : Math.min(Number.MAX_SAFE_INTEGER, time + ttl);
  if (!Number.isSafeInteger(maximumDevices) || maximumDevices < 1) throw new Error('Invalid mobile authorization device capacity');
  if (![accessTtlMs, idleTtlMs, absoluteTtlMs, socketGraceMs].every(value => Number.isSafeInteger(value) && value >= 0) || accessTtlMs < 100 || (idleTtlMs !== 0 && idleTtlMs < accessTtlMs) || (absoluteTtlMs !== 0 && (idleTtlMs === 0 || absoluteTtlMs < idleTtlMs)))
    throw new Error('Invalid mobile authorization lifetime');
  const root = resolve(directory, 'mobile-device-auth');
  const filePath = resolve(root, 'devices.json'); const keyPath = resolve(root, '.key');
  // Relay installations bind devices to the private installation store. Changing
  // transport or optional login credentials must not revoke paired phones.
  const identityHash = identity === null ? null : hash(identity);
  const enqueue = createBrowserSessionOperationQueue();
  let connectionIdentityPromise;
  const privateInfo = async path => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Unsafe mobile authorization storage');
    return info;
  };
  const connectionIdentityForKey = key => {
    const seed = createHmac('sha256', key).update(JSON.stringify(['kcoder.mobile.connection-identity.v1'])).digest();
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    const publicKey = publicBytes.toString('hex');
    return { privateKey, public: { version: 1, gatewayId: hash(publicBytes), publicKey } };
  };
  const readPrivate = async (path, maximum) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Unsafe mobile authorization file');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  };
  const transaction = (operation, kind = 'write') => {
    return enqueue(async () => {
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
      // Compatibility mutex shared with existing Gateway versions. A hash
      // collision can block an unrelated store; never bypass it or cache an
      // auth allow to hide contention. Replacing this protocol must interlock
      // with old processes, not introduce two independent writer locks.
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
        catch (error) { if (error.code !== 'ENOENT') throw error; hasStore = false; data = { version: 1, identityHash: identityHash ?? hash(mobileDeviceStoreIdentity('')), devices: [] }; }
        if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > maximumDevices || !validSecret(data.identityHash) || data.devices.some(device => !device || !validRotation(device.id) || !validRotation(device.authEpoch) || typeof device.label !== 'string' || device.label.length > 80 || !Number.isSafeInteger(device.generation) || device.generation < 0 || !validSecret(device.currentHash) || (device.previousHash !== null && !validSecret(device.previousHash)) || !validRotation(device.lastRotationId) || !['createdAt', 'lastUsedAt', 'expiresAt', 'absoluteExpiresAt', 'accessExpiresAt'].every(field => Number.isSafeInteger(device[field]) && device[field] >= 0))) throw new Error('Invalid mobile authorization store');
        // Capture before migrations/identity reconciliation: changed security
        // state must still commit, but a query must not rewrite/fsync the ledger.
        const previousEncoding = hasStore ? JSON.stringify(data) : null;
        let key;
        try { const rawKey = await readPrivate(keyPath, 128); if (!validSecret(rawKey)) throw new Error('Invalid mobile authorization key'); key = Buffer.from(rawKey, 'hex'); }
        catch (error) {
          if (error.code !== 'ENOENT' || hasStore) throw new Error('Mobile authorization key unavailable');
          key = randomBytes(32); const handle = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(key.toString('hex')); await handle.sync(); } finally { await handle.close(); }
        }
        if (key.length !== 32) throw new Error('Invalid mobile authorization key');
        // Existing v1 stores have no retained allocations. Never discard pending
        // facts when pairing prunes expired devices or the login token rotates.
        data.retentionRoutes ??= [];
        data.revocations ??= [];
        if ((data.revocationCursor !== undefined && (typeof data.revocationCursor !== 'string' || !/^[a-f0-9]{64}$/.test(data.revocationCursor))) ||
            !Array.isArray(data.retentionRoutes) || data.retentionRoutes.length > maximumRetentionRoutes ||
            data.retentionRoutes.some(row => !validRotation(row?.deviceId) || !validRotation(row?.authorizationGeneration) || !validLocalRetentionRoute(row?.route)) ||
            !Array.isArray(data.revocations) || data.revocations.length > maximumRevocationFacts ||
            data.revocations.some(row => !validRevocationStatement(row?.statement) || row.statement.gatewayNamespaceId !== privateVerifier(key).gatewayNamespaceId ||
              !Array.isArray(row.routes) || row.routes.length > maximumRetentionRoutes || row.routes.some(item => !validLocalRetentionRoute(item?.route) || typeof item.complete !== 'boolean')))
          throw new Error('Invalid mobile retention lifecycle store');
        if (new Set(data.revocations.map(row => `${row.statement.deviceId}:${row.statement.authorizationGeneration}`)).size !== data.revocations.length ||
            new Set(data.retentionRoutes.map(row => `${row.deviceId}:${row.authorizationGeneration}:${row.route.routeId}`)).size !== data.retentionRoutes.length ||
            data.revocations.some(row => new Set(row.routes.map(item => item.route.routeId)).size !== row.routes.length))
          throw new Error('Duplicate mobile retention lifecycle record');
        if (data.devices.some(device => device.completedRevocation !== undefined &&
            (!device.revoked || !validRevocationStatement(device.completedRevocation) || device.completedRevocation.gatewayNamespaceId !== privateVerifier(key).gatewayNamespaceId ||
             device.completedRevocation.deviceId !== device.id || device.completedRevocation.authorizationGeneration !== device.authEpoch ||
             !Array.isArray(device.completedRetentionRoutes) || device.completedRetentionRoutes.length > maximumRetentionRoutes || device.completedRetentionRoutes.some(id => !validSecret(id)))))
          throw new Error('Invalid completed device revocation');
        if (identityHash !== null && data.identityHash !== identityHash) {
          for (const id of new Set([...data.devices.map(device => device.id), ...data.retentionRoutes.map(row => row.deviceId)])) revokeIn(data, key, id);
          data.identityHash = identityHash;
          data.devices = [];
          data.browserSessions = [];
        }
        const result = await operation(data, key);
        const encoded = JSON.stringify(data);
        if (Buffer.byteLength(encoded) > 1048576) throw new MobileDeviceAuthError('Device lifecycle storage capacity reached', 429);
        if (encoded === previousEncoding) return result;
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, filePath);
          if (process.platform !== 'win32') { const parent = await open(root, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return result;
      } finally { await new Promise(done => locker.close(done)); }
    }, kind);
  };
  const derive = (key, purpose, ...values) => createHmac('sha256', key).update(JSON.stringify([purpose, ...values])).digest('hex');
  const loadConnectionIdentity = () => {
    if (!connectionIdentityPromise) {
      connectionIdentityPromise = transaction(async (_data, key) => connectionIdentityForKey(key)).catch(error => {
        connectionIdentityPromise = undefined;
        throw error;
      });
    }
    return connectionIdentityPromise;
  };
  const privateVerifier = key => ({ version: 1,
    gatewayNamespaceId: derive(key, 'kcoder.retention.gateway-namespace.v1'),
    key: derive(key, 'kcoder.retention.device-revocation-verifier.v1') });
  const revokeIn = (data, key, id) => {
    const device = data.devices.find(item => item.id === id);
    if (device?.completedRevocation) return { statement: device.completedRevocation, routes: [] };
    const epochs = [...new Set(data.retentionRoutes.filter(row => row.deviceId === id).map(row => row.authorizationGeneration))];
    if (epochs.length > 1) throw new Error('Ambiguous registered device authority');
    const epoch = device?.authEpoch ?? epochs[0];
    if (!epoch) return data.revocations.findLast(row => row.statement.deviceId === id) ?? null;
    let fact = data.revocations.find(row => row.statement.deviceId === id && row.statement.authorizationGeneration === epoch);
    if (!fact) {
      if (data.revocations.length >= maximumRevocationFacts) throw new MobileDeviceAuthError('Device lifecycle storage capacity reached', 429);
      fact = { statement: { version: 1, gatewayNamespaceId: privateVerifier(key).gatewayNamespaceId,
        deviceId: id, authorizationGeneration: epoch, revocationId: randomUUID(), revokedAt: now() },
        routes: data.retentionRoutes.filter(row => row.deviceId === id && row.authorizationGeneration === epoch).map(row => ({ route: row.route, complete: false })) };
      if (fact.routes.length) data.revocations.push(fact);
      else if (device) { device.completedRevocation = fact.statement; device.completedRetentionRoutes = []; }
    }
    if (device) device.revoked = true;
    return fact;
  };
  const pairingCredential = (data, key) => {
    const window = Math.floor(now() / pairingWindowMs);
    const generation = Number.isSafeInteger(data.pairingGeneration) && data.pairingGeneration >= 0 ? data.pairingGeneration : 0;
    return {
      token: derive(key, 'mobile-pairing.v1', data.identityHash, window, generation),
      webToken: derive(key, 'mobile-web-pairing.v1', data.identityHash, window, generation),
      expiresAt: Math.min(Number.MAX_SAFE_INTEGER, (window + 1) * pairingWindowMs),
    };
  };
  const response = (device, key, refreshToken) => ({
    accessToken: derive(key, 'access', device.id, device.generation, device.lastRotationId), expiresAt: device.accessExpiresAt,
    accessTtlMs, refreshToken, refreshExpiresAt: device.expiresAt, deviceId: device.id, authorizationGeneration: device.authEpoch, surface: device.surface === 'mobileWeb' ? 'mobileWeb' : 'mobileApp',
    // Configuration credential rotation may revoke devices, but cannot change
    // the installation namespace or claim another installation's old scope.
    retentionNamespaceId: derive(key, 'kcoder.retention.gateway-namespace.v1'),
    stableLoginOwner: `mobile-device:${device.id}`, wsLeaseExpiresAt: Math.min(device.expiresAt, device.absoluteExpiresAt, device.accessExpiresAt + socketGraceMs),
    capabilities: { mobileRefreshV1: true, mobileDeviceManagementV1: true },
  });
  const validDevice = device => !device.revoked && device.expiresAt > now() && device.absoluteExpiresAt > now();
  const inspectStore = operation => {
    return enqueue(async () => {
      let storageIdentity;
      try {
        await privateInfo(root);
        if (process.platform === 'win32') storageIdentity = await windowsPrivateDeviceStorage(root, false);
        else {
          const filesystem = await statfs(root);
          if ([0x6969, 0x517b, 0xff534d42].includes(filesystem.type)) throw new Error('Shared network mobile device storage is unsupported');
          const info = await lstat(root); storageIdentity = `local-file:${info.dev}:${info.ino}`;
        }
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      // Compatibility mutex shared with existing Gateway versions. A hash
      // collision can block an unrelated store; never bypass it or cache an
      // auth allow to hide contention. Replacing this protocol must interlock
      // with old processes, not introduce two independent writer locks.
      const lockPort = 49152 + (parseInt(hash(storageIdentity).slice(0, 8), 16) % 16384);
      const locker = createServer(socket => socket.destroy()); const lockDeadline = Date.now() + 4000;
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
          if (error.code !== 'EADDRINUSE' || Date.now() >= lockDeadline) throw new MobileDeviceAuthError('Device authorization local store lock unavailable', 503);
          await new Promise(done => setTimeout(done, 25));
        }
      }
      try {
        let data;
        try { data = JSON.parse(await readPrivate(filePath, 1048576)); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > maximumDevices || !validSecret(data.identityHash) ||
            data.devices.some(device => !device || !validRotation(device.id) || !validRotation(device.authEpoch) || typeof device.label !== 'string' || device.label.length > 80 || !Number.isSafeInteger(device.generation) || device.generation < 0 || !validSecret(device.currentHash) || (device.previousHash !== null && !validSecret(device.previousHash)) || !validRotation(device.lastRotationId) || !['createdAt', 'lastUsedAt', 'expiresAt', 'absoluteExpiresAt', 'accessExpiresAt'].every(field => Number.isSafeInteger(device[field]) && device[field] >= 0))) throw new Error('Invalid mobile authorization store');
        let key;
        try { const rawKey = await readPrivate(keyPath, 128); if (!validSecret(rawKey)) throw new Error('Invalid mobile authorization key'); key = Buffer.from(rawKey, 'hex'); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        if (key.length !== 32) throw new Error('Invalid mobile authorization key');
        const retentionRoutes = data.retentionRoutes ?? []; const revocations = data.revocations ?? [];
        if ((data.revocationCursor !== undefined && (typeof data.revocationCursor !== 'string' || !/^[a-f0-9]{64}$/.test(data.revocationCursor))) ||
            !Array.isArray(retentionRoutes) || retentionRoutes.length > maximumRetentionRoutes ||
            retentionRoutes.some(row => !validRotation(row?.deviceId) || !validRotation(row?.authorizationGeneration) || !validLocalRetentionRoute(row?.route)) ||
            !Array.isArray(revocations) || revocations.length > maximumRevocationFacts ||
            revocations.some(row => !validRevocationStatement(row?.statement) || row.statement.gatewayNamespaceId !== privateVerifier(key).gatewayNamespaceId ||
              !Array.isArray(row.routes) || row.routes.length > maximumRetentionRoutes || row.routes.some(item => !validLocalRetentionRoute(item?.route) || typeof item.complete !== 'boolean')) ||
            new Set(revocations.map(row => `${row.statement.deviceId}:${row.statement.authorizationGeneration}`)).size !== revocations.length ||
            new Set(retentionRoutes.map(row => `${row.deviceId}:${row.authorizationGeneration}:${row.route.routeId}`)).size !== retentionRoutes.length ||
            revocations.some(row => new Set(row.routes.map(item => item.route.routeId)).size !== row.routes.length) ||
            data.devices.some(device => device.completedRevocation !== undefined &&
              (!device.revoked || !validRevocationStatement(device.completedRevocation) || device.completedRevocation.gatewayNamespaceId !== privateVerifier(key).gatewayNamespaceId ||
               device.completedRevocation.deviceId !== device.id || device.completedRevocation.authorizationGeneration !== device.authEpoch ||
               !Array.isArray(device.completedRetentionRoutes) || device.completedRetentionRoutes.length > maximumRetentionRoutes || device.completedRetentionRoutes.some(id => !validSecret(id)))))
          throw new Error('Invalid mobile authorization store');
        if (identityHash !== null && data.identityHash !== identityHash) return undefined;
        return await operation(data, key);
      } finally { await new Promise(done => locker.close(done)); }
    }, 'read');
  };
  const pairInTransaction = (label, allowEviction, surface) => transaction(async (data, key) => {
    const evictedDeviceIds = [];
    if (allowEviction) {
      // Expired grants can still own durable retained data. Record cleanup
      // before removing those grants from the device list.
      for (const device of data.devices) {
        if (!device.revoked && !validDevice(device)) {
          const revocation = revokeIn(data, key, device.id);
          if (!revocation?.statement) throw new Error('Unable to record mobile device revocation');
          evictedDeviceIds.push(device.id);
        }
      }
    }
    data.devices = data.devices.filter(validDevice);
    if (data.devices.length >= maximumDevices) {
      if (!allowEviction) throw new MobileDeviceAuthError('Device limit reached', 429);
      // Device records are appended in registration order; wall-clock changes
      // must not reorder FIFO eviction.
      const oldest = data.devices[0];
      const revocation = revokeIn(data, key, oldest.id);
      if (!revocation?.statement) throw new Error('Unable to record mobile device revocation');
      evictedDeviceIds.push(oldest.id);
      data.devices = data.devices.filter(device => device.id !== oldest.id && validDevice(device));
    }
    // Reserve a future revoke fact before issuing a device authority. Pending
    // cleanup is never evicted to make pairing/allocation appear successful.
    const unrecorded = new Set([...data.devices.map(device => `${device.id}:${device.authEpoch}`),
      ...data.retentionRoutes.map(row => `${row.deviceId}:${row.authorizationGeneration}`)]
      .filter(id => !data.revocations.some(row => `${row.statement.deviceId}:${row.statement.authorizationGeneration}` === id))).size;
    if (data.revocations.length + unrecorded >= maximumRevocationFacts) throw new MobileDeviceAuthError('Device lifecycle storage capacity reached', 429);
    const refreshToken = randomBytes(32).toString('hex'); const time = now();
    const absoluteExpiresAt = deadline(time, absoluteTtlMs);
    const device = { id: randomUUID(), label: String(label).slice(0, 80), authEpoch: randomUUID(), generation: 0, currentHash: hash(refreshToken), previousHash: null, lastRotationId: randomUUID(), createdAt: time, lastUsedAt: time, expiresAt: Math.min(deadline(time, idleTtlMs), absoluteExpiresAt), absoluteExpiresAt, accessExpiresAt: deadline(time, accessTtlMs) };
    if (surface === 'mobileWeb') device.surface = surface;
    data.devices.push(device);
    return { grant: response(device, key, refreshToken), evictedDeviceIds };
  });
  const peerPairingCredentialForProof = async (nonce, offerHash, keyId, proof) => {
    if (!/^[a-f0-9]{48}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(offerHash) ||
        !validSecret(keyId) || !validSecret(proof)) return null;
    return inspectStore(async (data, key) => {
      if (!data || !key) return null;
      const { token, webToken } = pairingCredential(data, key);
      const credential = [fixedPairingToken, token, webToken]
        .find(value => value && equal(hash(value), keyId));
      if (!credential) return null;
      const gatewayId = connectionIdentityForKey(key).public.gatewayId;
      const expected = createHmac('sha256', Buffer.from(credential, 'utf8'))
        .update(peerOfferProofMessage(gatewayId, nonce, offerHash), 'utf8')
        .digest('hex');
      return equal(expected, proof) ? credential : null;
    });
  };
  return {
    browserSessions() { return createBrowserSessionPersistence({ transaction, inspect: inspectStore, maximumSessions: maximumDevices, now }); },
    async getConnectionIdentity() {
      const value = await loadConnectionIdentity();
      return { ...value.public };
    },
    inspectAccessAuthorization(accessToken) {
      if (!validSecret(accessToken)) return Promise.resolve(undefined);
      return inspectStore(async (data, key) => {
        const device = data.devices.find(item => {
          const expected = derive(key, 'access', item.id, item.generation, item.lastRotationId);
          return equal(accessToken, expected);
        });
        if (!device || !validDevice(device) || device.accessExpiresAt <= now()) return undefined;
        return {
          accessTokenHash: hash(accessToken),
          expiresAt: device.accessExpiresAt,
          accessExpiresAt: device.accessExpiresAt,
          wsLeaseExpiresAt: Math.min(device.expiresAt, device.absoluteExpiresAt, device.accessExpiresAt + socketGraceMs),
          refreshExpiresAt: device.expiresAt,
          deviceId: device.id,
          authorizationGeneration: device.authEpoch,
        };
      });
    },
    async signConnectionProof(nonce, endpoint) {
      if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce) ||
          canonicalGatewayConnectionUrl(endpoint) !== endpoint || isLoopbackGatewayConnectionUrl(endpoint)) {
        throw new MobileDeviceAuthError('Invalid Gateway connection proof request', 400);
      }
      let allowed = false;
      try { allowed = isConnectionEndpointAllowed(endpoint) === true; } catch { /* fail closed */ }
      if (!allowed) throw new MobileDeviceAuthError('Gateway connection endpoint is not allowed', 404);
      const value = await loadConnectionIdentity();
      return {
        version: 1,
        gatewayId: value.public.gatewayId,
        nonce,
        endpoint,
        signature: cryptoSign(null, Buffer.from(connectionProofMessage(value.public.gatewayId, nonce, endpoint)), value.privateKey).toString('hex'),
      };
    },
    async verifyPeerPairingProof(nonce, offerHash, keyId, proof) {
      return Boolean(await peerPairingCredentialForProof(nonce, offerHash, keyId, proof));
    },
    getPeerPairingCredentialForProof: peerPairingCredentialForProof,
    async signPeerAnswer(nonce, offerHash, answer) {
      if (!/^[a-f0-9]{48}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(offerHash) ||
          typeof answer !== 'string' || !answer || Buffer.byteLength(answer, 'utf8') > 64 * 1024 || answer.includes('\0')) {
        throw new MobileDeviceAuthError('Invalid Gateway peer answer', 400);
      }
      const value = await loadConnectionIdentity();
      return cryptoSign(null, Buffer.from(peerAnswerSignatureMessage(value.public.gatewayId, nonce, offerHash, answer), 'utf8'), value.privateKey).toString('hex');
    },
    getPairingCredential() { return transaction(async (data, key) => pairingCredential(data, key)); },
    rotatePairingCredential() { return transaction(async (data, key) => {
      const generation = Number.isSafeInteger(data.pairingGeneration) && data.pairingGeneration >= 0 ? data.pairingGeneration : 0;
      if (generation >= Number.MAX_SAFE_INTEGER) throw new Error('Mobile pairing credential generation exhausted');
      data.pairingGeneration = generation + 1;
      return pairingCredential(data, key);
    }); },
    matchesPairingCredential(value, surface) { return transaction(async (data, key) => {
      if (!validSecret(value)) return false;
      const pairing = pairingCredential(data, key);
      return equal(value, surface === 'mobileWeb' ? pairing.webToken : pairing.token);
    }); },
    async pair(label = 'Mobile device') { return (await pairInTransaction(label, false)).grant; },
    pairWithEviction(label = 'Mobile device', surface) { return pairInTransaction(label, true, surface); },
    refresh(refreshToken, rotationId, allowsSurface = () => true) { return transaction(async (data, key) => {
      if (!validSecret(refreshToken) || !validRotation(rotationId)) throw new MobileDeviceAuthError();
      const digest = hash(refreshToken);
      const device = data.devices.find(item => equal(item.currentHash, digest) || equal(item.previousHash, digest));
      if (!device || !validDevice(device)) throw new MobileDeviceAuthError();
      if (!allowsSurface(device.surface === 'mobileWeb' ? 'mobileWeb' : 'mobileApp')) throw new MobileDeviceAuthError('Public access is disabled', 403);
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
    revoke(id) { return transaction(async (data, key) => Boolean(revokeIn(data, key, id))); },
    revokeAndReadProof(id) { return transaction(async (data, key) => structuredClone(revokeIn(data, key, id)?.statement ?? null)); },
    // These APIs are for the Gateway composition root, never serialized in a
    // pairing/access/initialize response. A revoked client cannot call them.
    privateRetentionVerifier() { return transaction(async (_data, key) => privateVerifier(key)); },
    registerRetentionRoute({ deviceId, authorizationGeneration, route }) { return transaction(async data => {
      const device = data.devices.find(item => item.id === deviceId && item.authEpoch === authorizationGeneration);
      if (!device || !validDevice(device) || !validLocalRetentionRoute(route)) throw new MobileDeviceAuthError();
      const prior = data.retentionRoutes.find(row => row.deviceId === deviceId && row.authorizationGeneration === authorizationGeneration && row.route.routeId === route.routeId);
      if (prior) return structuredClone(prior.route);
      if (data.retentionRoutes.length >= maximumRetentionRoutes) throw new MobileDeviceAuthError('Device retention route capacity reached', 429);
      // Account for the eventual durable revoke snapshot before any RPC bytes.
      const row = { deviceId, authorizationGeneration, route };
      if (Buffer.byteLength(JSON.stringify(data)) + 2 * Buffer.byteLength(JSON.stringify(row)) + 2048 > 1048576)
        throw new MobileDeviceAuthError('Device lifecycle storage capacity reached', 429);
      data.retentionRoutes.push(structuredClone(row));
      return structuredClone(route);
    }); },
    pendingRetentionRevocations({ limit } = {}) { return transaction(async (data, key) => {
      const jobs = data.revocations.flatMap(fact => fact.routes.filter(item => !item.complete)
        .map(item => revocationRequest(fact.statement, item.route, privateVerifier(key))));
      if (limit === undefined) return jobs;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid retention delivery budget');
      const ordered = jobs.map(job => ({ job, id: hash(JSON.stringify([job.statement.revocationId, job.route.routeId])) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      let start = ordered.findIndex(item => !data.revocationCursor || item.id > data.revocationCursor);
      if (start < 0) start = 0;
      const selected = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, limit);
      if (selected.length) data.revocationCursor = selected.at(-1).id;
      return selected.map(item => item.job);
    }); },
    confirmRetentionRevocation(progress) { return transaction(async data => {
      if (progress?.version !== 1 || progress.complete !== true) throw new Error('Invalid retention completion receipt');
      const fact = data.revocations.find(row => row.statement.revocationId === progress.revocationId);
      const route = fact?.routes.find(item => item.route.routeId === progress.routeId);
      if (!route) {
        const completed = data.devices.find(device => device.completedRevocation?.revocationId === progress.revocationId);
        if (completed?.completedRetentionRoutes?.includes(progress.routeId)) return true;
        throw new Error('Unknown retention completion receipt');
      }
      route.complete = true;
      if (fact.routes.every(item => item.complete)) {
        const device = data.devices.find(item => item.id === fact.statement.deviceId && item.authEpoch === fact.statement.authorizationGeneration);
        if (device) {
          device.completedRevocation = fact.statement;
          device.completedRetentionRoutes = fact.routes.map(item => item.route.routeId);
        }
        data.retentionRoutes = data.retentionRoutes.filter(item => item.deviceId !== fact.statement.deviceId || item.authorizationGeneration !== fact.statement.authorizationGeneration);
        data.revocations = data.revocations.filter(item => item !== fact);
      }
      return true;
    }); },
  };
}
