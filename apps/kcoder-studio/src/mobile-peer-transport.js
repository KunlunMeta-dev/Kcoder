import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { PEER_CHANNEL_LABEL, PEER_FRAME_BYTES, PEER_MESSAGE_BYTES, PEER_TRANSPORT_VERSION, peerOfferProofMessage } from '../shared/gatewayPeerTransport.js';
import { createMobilePeerTunnel } from './mobile-peer-tunnel.js';
import { parseMobilePeerJson } from './mobile-peer-json.js';

const maximumSignalBodyBytes = 64 * 1024;
const maximumOfferBytes = 64 * 1024;
const maximumPeers = 16;
const maximumPendingSignalRequests = 32;
const maximumPerIpHandshakes = 2;
const maximumIpBuckets = 1024;
const maximumPerOwnerHandshakes = 2;
const maximumOwnerBuckets = 1024;
const offerTtlMs = 120_000;
const handshakeTimeoutMs = 10_000;
const hex48 = /^[a-f0-9]{48}$/;
const hex64 = /^[a-f0-9]{64}$/;
const tokenPattern = /^[A-Za-z0-9-]{32,128}$/;

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const constantEqual = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.length === right.length && /^[a-f0-9]+$/.test(left) && /^[a-f0-9]+$/.test(right) &&
  timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function ipv6Number(address) {
  if (address.includes('.')) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function localInterfaceCidrs() {
  const ranges = [];
  for (const rows of Object.values(networkInterfaces())) for (const row of rows ?? []) {
    if (row.internal) continue;
    if (row.cidr && isIP(row.address)) ranges.push(row.cidr);
    else if (row.family === 'IPv4' || row.family === 4) {
      const address = ipv4Number(row.address); const mask = ipv4Number(row.netmask);
      ranges.push(`${row.address}/${mask.toString(2).replace(/0/g, '').length}`);
      if (!Number.isFinite(address)) continue;
    }
  }
  return ranges;
}

function addressInCidr(address, cidr) {
  const [network, prefixRaw] = cidr.split('/'); const family = isIP(address);
  if (!family || isIP(network) !== family || !/^\d+$/.test(prefixRaw ?? '')) return false;
  const prefix = Number(prefixRaw);
  if (family === 4) {
    if (prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
  }
  if (prefix > 128) return false;
  const actual = ipv6Number(address); const base = ipv6Number(network);
  if (actual === null || base === null) return false;
  const shift = BigInt(128 - prefix); const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << shift) - 1n);
  return (actual & mask) === (base & mask);
}

function nonPublicAddress(address) {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    const ranges = [[0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4]];
    return ranges.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (isIP(address) === 6) {
    const value = ipv6Number(address);
    if (value === null) return true;
    const inRange = (base, bits) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
    return value === 0n || value === 1n || inRange(0xfc00n << 112n, 7) || inRange(0xfe80n << 112n, 10) ||
      inRange(0xff00n << 112n, 8) || inRange(0x20010db8n << 96n, 32) || inRange(0xfec0n << 112n, 10);
  }
  return true;
}

function hardDeniedAddress(address) {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return [[0x00000000, 8], [0x7f000000, 8], [0xa9fe0000, 16], [0xe0000000, 4], [0xf0000000, 4]]
      .some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (isIP(address) === 6) {
    const value = ipv6Number(address);
    if (value === null) return true;
    const inRange = (base, bits) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
    return value === 0n || value === 1n || inRange(0xfe80n << 112n, 10) || inRange(0xff00n << 112n, 8);
  }
  return true;
}

function privatePeerAddress(address) {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return [[0x0a000000, 8], [0x64400000, 10], [0xac100000, 12], [0xc0a80000, 16]]
      .some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (isIP(address) === 6) {
    const value = ipv6Number(address);
    return value !== null && (value >> 121n) === 0x7en;
  }
  return false;
}

function subnetBroadcast(address, cidrs) {
  if (isIP(address) !== 4) return false;
  const value = ipv4Number(address);
  return cidrs.some(cidr => {
    const [network, prefixText] = cidr.split('/'); const prefix = Number(prefixText);
    if (isIP(network) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix >= 31) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return value === (((ipv4Number(network) & mask) | (~mask >>> 0)) >>> 0);
  });
}

export function sanitizePeerOfferCandidates(offer, allowedCidrs = localInterfaceCidrs()) {
  if (!validPeerOffer(offer)) return null;
  let candidates = 0; let accepted = 0;
  const lines = offer.split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) { result.push(line); continue; }
    candidates += 1;
    if (candidates > 64) return null;
    const fields = line.slice(2).split(/\s+/);
    if (fields.length < 8 || fields[6] !== 'typ' || !['host', 'srflx', 'prflx', 'relay'].includes(fields[7]) ||
        !['udp', 'tcp'].includes(fields[2]?.toLowerCase())) continue;
    const address = fields[4]; const port = Number(fields[5]);
    if (!isIP(address) || !Number.isInteger(port) || port < 1024 || port > 65535 || hardDeniedAddress(address)) continue;
    const localRange = allowedCidrs.some(cidr => addressInCidr(address, cidr));
    if (nonPublicAddress(address) && (!privatePeerAddress(address) || !localRange || subnetBroadcast(address, allowedCidrs))) continue;
    result.push(line); accepted += 1;
  }
  return accepted > 0 ? result.join('\r\n') : null;
}

export function validPeerCandidateAddresses(offer, allowedCidrs = localInterfaceCidrs()) {
  return sanitizePeerOfferCandidates(offer, allowedCidrs) !== null;
}

export function parsePeerStunUrls(value) {
  if (typeof value !== 'string' || value.length > 2048) return [];
  const urls = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!urls.length || urls.length > 4) return [];
  for (const url of urls) {
    if (!url.startsWith('stun:') || url.includes('@') || /[/?#\s]/.test(url.slice(5))) return [];
    const authority = url.slice(5);
    if (!/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253})(?::[0-9]{1,5})?$/.test(authority)) return [];
    const port = authority.match(/:(\d+)$/)?.[1];
    if (port && (Number(port) < 1 || Number(port) > 65535)) return [];
  }
  return [...new Set(urls)];
}

export function validPeerOffer(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumOfferBytes || value.includes('\0')) return false;
  const lines = value.split(/\r?\n/);
  if (lines.length > 4096 || lines.some(line => Buffer.byteLength(line, 'utf8') > 4096) || lines[0] !== 'v=0') return false;
  const media = lines.filter(line => line.startsWith('m='));
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/i.test(media[0])) return false;
  return true;
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

async function readBoundedRequest(request, maximumBytes, timeoutMs) {
  const declared = request.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maximumBytes)) {
    request.destroy?.();
    const error = new Error('Signal body too large'); error.status = 413; throw error;
  }
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > maximumBytes) { request.destroy?.(); const error = new Error('Signal body too large'); error.status = 413; throw error; }
          chunks.push(chunk);
        }
        if (declared !== undefined && bytes !== Number(declared)) throw new Error('Signal body length mismatch');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { throw new Error('Signal body is not valid UTF-8'); }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Signal body timeout');
        request.destroy?.(error);
        reject(error);
      }, timeoutMs); timer.unref?.(); }),
    ]);
  } finally { clearTimeout(timer); }
}

function validOfferPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === 4 && Object.keys(payload).every(key => ['version', 'nonce', 'offer', 'auth'].includes(key)) &&
    payload.version === 1 && typeof payload.nonce === 'string' && hex48.test(payload.nonce) && validPeerOffer(payload.offer) &&
    payload.auth && typeof payload.auth === 'object' && !Array.isArray(payload.auth) &&
    Object.keys(payload.auth).length === 3 && Object.keys(payload.auth).every(key => ['kind', 'keyId', 'proof'].includes(key)) &&
    ['pairing', 'access'].includes(payload.auth.kind) && typeof payload.auth.keyId === 'string' && hex64.test(payload.auth.keyId) &&
    typeof payload.auth.proof === 'string' && hex64.test(payload.auth.proof);
}

function publicError(response, status, error) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error }));
}

function onlyApplicationSdp(offer) {
  return validPeerOffer(offer);
}

function nativeModule(module) { return module?.default && module.PeerConnection === undefined ? module.default : module; }

export function createMobilePeerTransport({
  enabled = false,
  stunUrls: rawStunUrls = '',
  mobileDeviceAuth,
  getIdentity,
  jsonResponse,
  getLocalBase,
  rpcToken,
  authSessionById,
  authSessions,
  mobileDeviceFamilies,
  ownership,
  allowsSurface = () => true,
  getTarget = () => null,
  getDefaultTarget = () => null,
  getTargetIds = () => [],
  loadRtc = () => import('node-datachannel'),
  loadWebSocket = () => import('ws'),
  now = Date.now,
  timeoutMs = handshakeTimeoutMs,
}) {
  if (typeof getIdentity !== 'function' || typeof getLocalBase !== 'function' ||
      !mobileDeviceAuth || typeof mobileDeviceAuth.signPeerAnswer !== 'function' ||
      typeof mobileDeviceAuth.getPeerPairingCredentialForProof !== 'function' || !(authSessions instanceof Map) ||
      typeof authSessionById !== 'function' || typeof jsonResponse !== 'function' || !(mobileDeviceFamilies instanceof Map) || !ownership) {
    throw new TypeError('Invalid Gateway peer transport dependencies');
  }

  const stunUrls = parsePeerStunUrls(rawStunUrls);
  const peers = new Set();
  const reservations = new Map();
  const ipBuckets = new Map();
  const activeByIp = new Map();
  const ownerBuckets = new Map();
  const activeByOwner = new Map();
  const offerRequests = new Set();
  let rtcPromise;
  let websocketPromise;
  let closed = false;
  let activePeerSlots = 0;

  function releasePeerSlot(entry) {
    if (!entry?.slotOwned) return;
    entry.slotOwned = false;
    activePeerSlots = Math.max(0, activePeerSlots - 1);
  }

  async function rtcModule() {
    rtcPromise ??= Promise.resolve().then(loadRtc).then(nativeModule).then(rtc => {
      if (typeof rtc?.PeerConnection !== 'function') throw new Error('Native WebRTC addon unavailable');
      rtc.initLogger?.('Error');
      return rtc;
    }).catch(error => { rtcPromise = undefined; throw error; });
    return rtcPromise;
  }

  async function webSocketModule() {
    websocketPromise ??= Promise.resolve().then(loadWebSocket).then(module => module?.default?.WebSocket ? module.default : module).then(module => {
      const WebSocket = module?.WebSocket ?? module;
      if (typeof WebSocket !== 'function') throw new Error('WebSocket bridge unavailable');
      return WebSocket;
    }).catch(error => { websocketPromise = undefined; throw error; });
    return websocketPromise;
  }

  function ready() { return enabled && !closed && stunUrls.length > 0; }
  const rtcPreflight = ready() ? rtcModule().then(rtc => rtc).catch(() => null) : Promise.resolve(null);
  const configRate = new Map();

  function permitConfig(ip) {
    const time = now();
    for (const [address, row] of configRate) if (time - row.start >= 60_000) configRate.delete(address);
    if (!configRate.has(ip) && configRate.size >= maximumIpBuckets) configRate.delete(configRate.keys().next().value);
    const row = configRate.get(ip) ?? { start: time, count: 0 };
    if (time - row.start >= 60_000) { row.start = time; row.count = 0; }
    if (row.count >= 30) return false;
    row.count += 1; configRate.set(ip, row); return true;
  }

  function permitIp(ip) {
    const time = now();
    for (const [address, row] of ipBuckets) if (time - row.start >= 60_000) ipBuckets.delete(address);
    if (!ipBuckets.has(ip) && ipBuckets.size >= maximumIpBuckets) ipBuckets.delete(ipBuckets.keys().next().value);
    const bucket = ipBuckets.get(ip) ?? { start: time, count: 0 };
    if (time - bucket.start >= 60_000) { bucket.start = time; bucket.count = 0; }
    const loopback = isLoopbackAddress(ip);
    if (bucket.count >= (loopback ? 60 : 6) || (activeByIp.get(ip) ?? 0) >= (loopback ? 8 : maximumPerIpHandshakes)) return false;
    bucket.count += 1; ipBuckets.set(ip, bucket);
    activeByIp.set(ip, (activeByIp.get(ip) ?? 0) + 1);
    return true;
  }

  function releaseIp(ip) {
    const count = activeByIp.get(ip) ?? 0;
    if (count <= 1) activeByIp.delete(ip); else activeByIp.set(ip, count - 1);
  }

  function permitOwner(keyId) {
    const time = now();
    for (const [key, row] of ownerBuckets) if (time - row.start >= 60_000) ownerBuckets.delete(key);
    if (!ownerBuckets.has(keyId) && ownerBuckets.size >= maximumOwnerBuckets) ownerBuckets.delete(ownerBuckets.keys().next().value);
    const row = ownerBuckets.get(keyId) ?? { start: time, count: 0 };
    if (time - row.start >= 60_000) { row.start = time; row.count = 0; }
    if (row.count >= 12 || (activeByOwner.get(keyId) ?? 0) >= maximumPerOwnerHandshakes) return false;
    row.count += 1; ownerBuckets.set(keyId, row);
    activeByOwner.set(keyId, (activeByOwner.get(keyId) ?? 0) + 1);
    return true;
  }

  function releaseOwner(keyId) {
    if (!keyId) return;
    const count = activeByOwner.get(keyId) ?? 0;
    if (count <= 1) activeByOwner.delete(keyId); else activeByOwner.set(keyId, count - 1);
  }

  async function verifyOfferAuth(auth, gatewayId, nonce, offerHash) {
    const message = peerOfferProofMessage(gatewayId, nonce, offerHash);
    if (auth.kind === 'pairing') {
      const token = await mobileDeviceAuth.getPeerPairingCredentialForProof(nonce, offerHash, auth.keyId, auth.proof);
      if (!token) return null;
      const web = await mobileDeviceAuth.matchesPairingCredential?.(token, 'mobileWeb');
      return { kind: 'pairing', keyId: auth.keyId, token, surface: web ? 'mobileWeb' : 'mobileApp' };
    }
    for (const [token, currentSession] of authSessions) {
      if (!tokenPattern.test(token) || !constantEqual(digest(token), auth.keyId)) continue;
      const current = await authSessionById(token);
      if (!current || current !== currentSession || authSessions.get(token) !== current || !current.deviceId) return null;
      const durable = await mobileDeviceAuth.inspectAccessAuthorization(token);
      if (!durable || durable.accessTokenHash !== digest(token) || durable.deviceId !== current.deviceId ||
          durable.authorizationGeneration !== current.authorizationGeneration || durable.accessExpiresAt <= now()) return null;
      const expected = createHmac('sha256', Buffer.from(token, 'utf8')).update(message, 'utf8').digest('hex');
      return constantEqual(expected, auth.proof) ? { kind: 'access', keyId: auth.keyId, token, surface: current.surface || 'mobileApp' } : null;
    }
    return null;
  }

  function pruneReservations() {
    const time = now();
    for (const [key, entry] of reservations) {
      if (entry.expiresAt > time || !entry.closed) continue;
      reservations.delete(key);
    }
    while (reservations.size > 256) {
      const candidate = [...reservations].find(([, entry]) => entry.closed);
      if (!candidate) break;
      reservations.delete(candidate[0]);
    }
  }

  async function handleHttp(request, response, requestUrl) {
    if (!['/api/mobile/p2p', '/api/mobile/p2p/offer'].includes(requestUrl.pathname)) return false;
    if (!ready()) { publicError(response, 404, 'Gateway peer transport unavailable'); return true; }
    if (requestUrl.search || request.url !== requestUrl.pathname) { publicError(response, 404, 'Gateway peer route unavailable'); return true; }
    if (requestUrl.pathname === '/api/mobile/p2p') {
      if (request.method !== 'GET') { publicError(response, 405, 'Method not allowed'); return true; }
      if (!permitConfig(request.socket?.remoteAddress || 'unknown')) { publicError(response, 429, 'Gateway peer config rate limit reached'); return true; }
      try {
        if (!await rtcPreflight) throw new Error('Native addon unavailable');
        const identity = await getIdentity();
        jsonResponse(response, 200, { version: PEER_TRANSPORT_VERSION, gatewayId: identity.gatewayId, stunUrls });
      } catch { publicError(response, 404, 'Gateway peer transport unavailable'); }
      return true;
    }
    if (request.method !== 'POST') { publicError(response, 405, 'Method not allowed'); return true; }
    if (request.headers?.['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      publicError(response, 415, 'Peer offer requires application/json'); return true;
    }
    const ip = request.socket?.remoteAddress || 'unknown';
    if (offerRequests.size >= maximumPendingSignalRequests) { publicError(response, 429, 'Gateway peer signal capacity reached'); return true; }
    if (!permitIp(ip)) { publicError(response, 429, 'Gateway peer offer rate limit reached'); return true; }
    offerRequests.add(request);
    let ownerKey = null;
    try {
      const raw = await readBoundedRequest(request, maximumSignalBodyBytes, timeoutMs);
      const payload = parseMobilePeerJson(raw);
      const acceptedOffer = validOfferPayload(payload) && onlyApplicationSdp(payload.offer)
        ? sanitizePeerOfferCandidates(payload.offer)
        : null;
      if (!acceptedOffer) {
        publicError(response, 400, 'Invalid peer offer'); return true;
      }
      const identity = await getIdentity();
      const offerHash = digest(payload.offer);
      const proofOwner = await verifyOfferAuth(payload.auth, identity.gatewayId, payload.nonce, offerHash);
      if (!proofOwner) { publicError(response, 401, 'Peer offer credential rejected'); return true; }
      if (!allowsSurface(proofOwner.surface)) { publicError(response, 403, 'Public access is disabled'); return true; }
      ownerKey = proofOwner.keyId;
      if (!permitOwner(ownerKey)) { ownerKey = null; publicError(response, 429, 'Gateway peer credential rate limit reached'); return true; }
      if (closed) { publicError(response, 503, 'Gateway peer transport unavailable'); return true; }
      pruneReservations();
      const key = `${proofOwner.keyId}:${payload.nonce}`;
      const old = reservations.get(key);
      if (old) {
        if (old.offerHash !== offerHash) { publicError(response, 409, 'Peer offer nonce conflict'); return true; }
        if (old.closed) { publicError(response, 409, 'Peer offer is no longer active'); return true; }
        const result = await old.answerPromise;
        jsonResponse(response, 200, result);
        return true;
      }
      if (activePeerSlots >= maximumPeers || reservations.size >= 256 || closed) {
        publicError(response, 429, 'Gateway peer capacity reached'); return true;
      }
      activePeerSlots += 1;
      const entry = { offerHash, expiresAt: now() + offerTtlMs, closed: false, answerPromise: null, peer: null, slotOwned: true, surface: proofOwner.surface };
      reservations.set(key, entry);
      try {
        entry.answerPromise = (async () => {
          try {
            const rtc = await rtcPreflight;
            if (!rtc) { const error = new Error('Native addon unavailable'); error.status = 404; throw error; }
            if (closed || reservations.get(key) !== entry || entry.closed) throw new Error('Gateway peer transport is closing');
            const WebSocket = await webSocketModule();
            if (closed || reservations.get(key) !== entry || entry.closed) throw new Error('Gateway peer transport is closing');
            return await createPeer({ payload, acceptedOffer, identity, offerHash, proofOwner, entry, ip, rtc, WebSocket });
          } catch (error) {
            releasePeerSlot(entry);
            entry.closed = true;
            throw error;
          }
        })();
        const result = await entry.answerPromise;
        jsonResponse(response, 200, result);
      } catch (error) {
        releasePeerSlot(entry);
        entry.closed = true;
        reservations.delete(key);
        publicError(response, error?.status ?? 503, error?.status === 404 ? 'Gateway peer transport unavailable' : error?.status === 429 ? 'Gateway peer capacity reached' : 'Gateway peer negotiation failed');
      }
      return true;
    } catch (error) {
      publicError(response, error?.status || (/timeout/i.test(String(error?.message)) ? 408 : 400),
        error?.status === 413 ? 'Peer offer body is too large' : 'Invalid peer offer');
      return true;
    } finally {
      offerRequests.delete(request);
      releaseIp(ip);
      releaseOwner(ownerKey);
    }
  }

  async function createPeer({ payload, acceptedOffer, identity, offerHash, proofOwner, entry, ip, rtc, WebSocket }) {
    const handle = new EventEmitter();
    let closed = false;
    let pc = null;
    let tunnel = null;
    let dataChannel = null;
    let identityTimer;
    let answerReject;
    const record = { pc: null, handle, tunnel: null, remoteAddress: ip };
    entry.peer = record;
    peers.add(record);
    entry.closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      entry.closed = true;
      releasePeerSlot(entry);
      clearTimeout(handshakeTimer);
      clearTimeout(identityTimer);
      answerReject?.(new Error('Peer transport closed before answer was complete'));
      tunnel?.close();
      ownership.close(handle);
      try { dataChannel?.close(); } catch { /* Native teardown is best-effort. */ }
      try { pc?.close(); } catch { /* Native teardown is best-effort. */ }
      peers.delete(record);
      handle.emit('close');
    };
    handle.destroy = cleanup;
    handle.close = cleanup;
    const handshakeTimer = setTimeout(cleanup, timeoutMs);
    handshakeTimer.unref?.();
    let answerResolve;
    const answerPromise = new Promise((resolve, reject) => { answerResolve = resolve; answerReject = reject; });
    const answerTimer = setTimeout(() => answerReject(new Error('Peer answer timeout')), timeoutMs);
    answerTimer.unref?.();
    try {
      let initialSession = null;
      if (proofOwner.kind === 'access') {
        initialSession = await ownership.bind(handle, proofOwner.token);
        if (!initialSession) { const error = new Error('Peer offer owner expired'); error.status = 401; throw error; }
      }
      if (closed || !peers.has(record)) throw new Error('Peer transport closed during authorization');
      pc = new rtc.PeerConnection(`kcoder-${payload.nonce.slice(0, 12)}`, {
        iceServers: stunUrls,
        maxMessageSize: PEER_FRAME_BYTES,
        iceTransportPolicy: 'all',
      });
      record.pc = pc;
      tunnel = createMobilePeerTunnel({
        pc, handle, WebSocket, getLocalBase, rpcToken,
        authSessionById, authSessions, ownership,
        getDeviceFamily: deviceId => mobileDeviceFamilies.get(deviceId),
        getTarget, getDefaultTarget, getTargetIds,
        pairingProof: proofOwner.kind === 'pairing',
        offerOwnerToken: proofOwner.token,
        offerOwnerKind: proofOwner.kind,
        initialSession,
      });
      record.tunnel = tunnel;
      let candidateAnswer = null;
      let gatheringComplete = false;
      const resolveGatheredAnswer = () => {
        if (!gatheringComplete || closed) return;
        let local;
        try { local = pc.localDescription?.(); } catch { local = null; }
        const answer = local?.type && String(local.type).toLowerCase() !== 'answer' ? null : local?.sdp ?? candidateAnswer;
        if (!validPeerOffer(answer)) { answerReject(new Error('Native answer is incomplete')); return; }
        answerResolve(answer);
      };
      pc.onGatheringStateChange?.(state => {
        if (String(state).toLowerCase() === 'complete') { gatheringComplete = true; resolveGatheredAnswer(); }
      });
      pc.onLocalDescription?.((answer, type) => {
        if (String(type).toLowerCase() !== 'answer' || !validPeerOffer(answer)) {
          answerReject(new Error('Invalid native answer')); return;
        }
        candidateAnswer = answer;
        if (typeof pc.gatheringState !== 'function' || String(pc.gatheringState()).toLowerCase() === 'complete') {
          gatheringComplete = true; resolveGatheredAnswer();
        }
      });
      pc.onStateChange?.(state => {
        const normalized = String(state).toLowerCase();
        if (normalized === 'failed' || normalized === 'closed') cleanup();
        if (normalized === 'connected') {
          let pair;
          try { pair = pc.getSelectedCandidatePair?.(); } catch { pair = null; }
          const type = `${pair?.local?.type ?? ''} ${pair?.remote?.type ?? ''}`.toLowerCase();
          if (!pair?.local?.type || !pair?.remote?.type || type.includes('relay')) cleanup();
        }
      });
      pc.onDataChannel?.(channel => {
        if (dataChannel || channel.getLabel?.() !== PEER_CHANNEL_LABEL) { channel.close?.(); cleanup(); return; }
        dataChannel = channel;
        channel.setBufferedAmountLowThreshold?.(256 * 1024);
        channel.onOpen?.(() => {
          tunnel.attach(channel);
          clearTimeout(handshakeTimer);
          if (!tunnel.authenticated) {
            identityTimer = setTimeout(() => { if (!tunnel.authenticated) cleanup(); }, timeoutMs);
            identityTimer.unref?.();
          }
        });
        channel.onMessage?.(message => tunnel.receive(message));
        channel.onClosed?.(cleanup);
        channel.onError?.(cleanup);
      });
      if (closed) throw new Error('Peer transport closed during setup');
      pc.setRemoteDescription(acceptedOffer, 'Offer');
      const answer = await answerPromise;
      const signature = await mobileDeviceAuth.signPeerAnswer(payload.nonce, offerHash, answer);
      return { version: 1, gatewayId: identity.gatewayId, nonce: payload.nonce, offerHash, answer, signature };
    } catch (error) {
      cleanup();
      throw error;
    } finally { clearTimeout(answerTimer); }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const entry of reservations.values()) {
      entry.closed = true;
      releasePeerSlot(entry);
      entry.peer?.handle.destroy?.();
    }
    for (const request of offerRequests) request.destroy?.();
    peers.clear();
    reservations.clear();
    ipBuckets.clear();
    activeByIp.clear();
    ownerBuckets.clear();
    activeByOwner.clear();
    configRate.clear();
    activePeerSlots = 0;
  }

  function closeDisabled() {
    for (const entry of reservations.values()) {
      if (entry.closed || allowsSurface(entry.surface)) continue;
      entry.closed = true;
      releasePeerSlot(entry);
      entry.peer?.handle.destroy?.();
    }
  }

  return { handleHttp, close, closeDisabled, get ready() { return ready(); }, get peerCount() { return peers.size; } };
}
