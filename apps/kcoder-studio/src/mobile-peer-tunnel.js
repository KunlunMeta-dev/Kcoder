import { request as httpRequest } from 'node:http';
import { Buffer } from 'node:buffer';
import { parseMobilePeerJson } from './mobile-peer-json.js';
import {
  PEER_BUFFER_HIGH_WATERMARK,
  PEER_CHUNK_BYTES,
  PEER_FRAME_BYTES,
  PEER_MAX_OPERATIONS,
  PEER_MESSAGE_BYTES,
  PEER_TRANSPORT_VERSION,
  decodedPeerChunkBytes,
  encodePeerFrame,
  parsePeerFrame,
  peerUtf8Length,
} from '../shared/gatewayPeerTransport.js';

const maxQueuedBytes = 1024 * 1024;
const maxAggregateMessageBytes = 16 * 1024 * 1024;
const drainTimeoutMs = 5_000;
const idleTimeoutMs = 10_000;
const maximumWsAssemblies = 8;
const allowedChannels = new Set(['runtime', 'browser', 'ssh-terminal']);
const bearerPattern = /^Bearer ([A-Za-z0-9-]{32,128})$/;

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
const targetFromPath = path => {
  const id = path.match(/^\/api\/servers\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/|$)/)?.[1] ?? null;
  return id === 'status' || id === 'test' ? null : id;
};

function safeLocalBase(getLocalBase) {
  const raw = getLocalBase();
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Gateway peer loopback endpoint is unavailable');
  }
  return url;
}

function parseBearer(value) {
  if (typeof value !== 'string') return null;
  return value.match(bearerPattern)?.[1] ?? null;
}

function filteredHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') result[name.toLowerCase()] = value;
  }
  return result;
}

function responseLength(headers) {
  const value = headers['content-length'];
  return value && /^\d+$/.test(value) && Number(value) <= PEER_MESSAGE_BYTES ? Number(value) : null;
}

function utf8Text(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

export function createMobilePeerTunnel({
  pc,
  handle,
  WebSocket,
  getLocalBase,
  rpcToken,
  authSessionById,
  authSessions,
  ownership,
  pairingProof,
  getTarget = () => null,
  getDefaultTarget = () => null,
  getTargetIds = () => [],
  now = Date.now,
  getDeviceFamily = () => null,
  initialSession = null,
  offerOwnerKind = 'pairing',
  offerOwnerToken = null,
}) {
  const operations = new Map();
  let channel = null;
  let closed = false;
  let authenticated = false;
  let initialAccessTokenSeen = false;
  let sawPairingRequest = false;
  let pendingFrames = 0;
  let pendingBytes = 0;
  let aggregateBytes = 0;
  let activeAssemblies = 0;
  let boundDeviceId = initialSession?.deviceId ?? null;
  let boundGeneration = initialSession?.authorizationGeneration ?? null;
  let activityAt = now();
  let idleTimer;
  let receiveChain = Promise.resolve();

  const resetIdleTimer = () => {
    activityAt = now();
    clearTimeout(idleTimer);
    if (operations.size === 0) {
      idleTimer = setTimeout(() => { if (now() - activityAt >= idleTimeoutMs) close(); }, idleTimeoutMs);
      idleTimer.unref?.();
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    for (const operation of operations.values()) operation.close?.();
    operations.clear();
    aggregateBytes = 0; activeAssemblies = 0;
    try { channel?.close?.(); } catch { /* DataChannel teardown is best-effort. */ }
  }

  async function waitForDrain(nextFrameBytes) {
    const started = now();
    while (!closed && Number(channel?.bufferedAmount?.() ?? 0) + nextFrameBytes > PEER_BUFFER_HIGH_WATERMARK) {
      if (now() - started >= drainTimeoutMs) throw new Error('Peer DataChannel backpressure timeout');
      await sleep(20);
    }
    if (closed || !channel?.isOpen?.()) throw new Error('Peer DataChannel is closed');
  }

  async function send(value) {
    if (closed || !channel) throw new Error('Peer DataChannel is closed');
    const raw = encodePeerFrame(value);
    if (peerUtf8Length(raw) > PEER_FRAME_BYTES) throw new RangeError('Peer frame is too large');
    await waitForDrain(peerUtf8Length(raw));
    // node-datachannel returns false when it accepted the message into its buffered send queue.
    channel.sendMessage(raw);
    resetIdleTimer();
  }

  async function sendError(id, code) {
    try { await send({ version: PEER_TRANSPORT_VERSION, type: 'error', id, code }); } catch { close(); }
  }

  async function sendBytes(type, id, bytes, extra = {}) {
    const total = bytes.length;
    if (total > PEER_MESSAGE_BYTES || aggregateBytes + total > maxAggregateMessageBytes) throw new RangeError('Peer message limit exceeded');
    aggregateBytes += total;
    try {
      await send({ version: 1, type: type.start, id, ...extra, byteLength: total });
      let seq = 0;
      for (let offset = 0; offset < total; offset += PEER_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + PEER_CHUNK_BYTES, total));
        await send({ version: 1, type: type.chunk, id, ...(extra.messageId ? { messageId: extra.messageId } : {}), seq, data: chunk.toString('base64') });
        seq += 1;
      }
      await send({ version: 1, type: type.end, id, ...(extra.messageId ? { messageId: extra.messageId } : {}) });
    } finally { aggregateBytes = Math.max(0, aggregateBytes - total); }
  }

  async function authenticateToken(token, targetId = null, { sameFamilyRotation = false } = {}) {
    if (!token || !authSessionById || !authSessions) return null;
    if (offerOwnerKind === 'access' && !initialAccessTokenSeen && token !== offerOwnerToken && !sameFamilyRotation) return null;
    const session = await authSessionById(token);
    if (!session || authSessions.get(token) !== session) return null;
    const owner = await ownership.bind(handle, token, targetId);
    if (!owner || owner !== session) return null;
    if (session.deviceId) {
      if (boundDeviceId && boundDeviceId !== session.deviceId) return null;
      if (boundGeneration && boundGeneration !== session.authorizationGeneration) return null;
      boundDeviceId = session.deviceId;
      boundGeneration = session.authorizationGeneration;
    }
    if (offerOwnerKind === 'access' && !initialAccessTokenSeen && (token === offerOwnerToken || sameFamilyRotation)) initialAccessTokenSeen = true;
    else if (offerOwnerKind === 'pairing' && !initialAccessTokenSeen) initialAccessTokenSeen = true;
    authenticated = true;
    return session;
  }

  function refreshOwnerIsCurrent() {
    if (!authenticated || !boundDeviceId || !boundGeneration) return false;
    const family = getDeviceFamily(boundDeviceId);
    return Boolean(family && family.authorizationGeneration === boundGeneration && family.expiresAt > now() && family.sockets?.has(handle));
  }

  authenticated = Boolean(initialSession);

  async function makeHttpOperation(frame) {
    const headers = filteredHeaders(frame.headers);
    const bearer = parseBearer(headers.authorization);
    const isPairRequest = frame.method === 'POST' && frame.path.split('?', 1)[0] === '/api/mobile/session';
    const isRefreshRequest = frame.method === 'POST' && frame.path === '/api/mobile/session/refresh';
    let session = null;
    const pairRequest = !authenticated && isPairRequest;
    const refreshRequest = isRefreshRequest;
    if (authenticated && isPairRequest) throw new Error('Peer pairing is only available before authentication');
    if (!authenticated) {
      if (!pairingProof || sawPairingRequest || !isPairRequest || bearer || frame.bodyLength === null || frame.bodyLength < 1 || frame.bodyLength > 4096) {
        throw new Error('Peer session authentication required');
      }
      if (headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error('Pairing requires JSON');
    } else if (refreshRequest) {
      if (!authenticated || bearer || frame.bodyLength === null || frame.bodyLength < 1 || frame.bodyLength > 4096 || !refreshOwnerIsCurrent() ||
          headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        throw new Error('Device refresh is unavailable');
      }
    } else {
      if (!bearer) throw new Error('Bearer authorization required');
      session = await authenticateToken(bearer, targetFromPath(frame.path));
      if (!session) throw new Error('Bearer authorization expired');
    }
    if (bearer && !session) throw new Error('Bearer authorization rejected');
    const local = safeLocalBase(getLocalBase);
    const target = new URL(frame.path, local);
    if (target.origin !== local.origin || !target.pathname.startsWith('/api/')) throw new Error('Gateway API path rejected');
    const requestHeaders = { ...headers, host: local.host, connection: 'keep-alive' };
    if (frame.bodyLength === null) requestHeaders['transfer-encoding'] = 'chunked';
    else requestHeaders['content-length'] = String(frame.bodyLength);
    const operation = {
      kind: 'http', id: frame.id, req: null, expected: frame.bodyLength, received: 0, seq: 0, ended: false,
      pairRequest, refreshRequest, pairChunks: [],
      createRequest() {
        const req = httpRequest({
          protocol: local.protocol,
          hostname: local.hostname.replace(/^\[|\]$/g, ''),
          port: local.port,
          method: frame.method,
          path: `${target.pathname}${target.search}`,
          headers: requestHeaders,
          timeout: 30_000,
          maxHeaderSize: 16 * 1024,
        });
        operation.req = req;
        req.on('response', response => { void handleHttpResponse(operation, response).catch(() => failOperation(frame.id, 'http_failed')); });
        req.on('error', () => { void failOperation(frame.id, 'http_failed'); });
        req.on('timeout', () => { req.destroy(new Error('Gateway HTTP request timed out')); });
        return req;
      },
      close() { operation.req?.destroy(); operations.delete(frame.id); },
    };
    operations.set(frame.id, operation);
    if (pairRequest) sawPairingRequest = true;
    else if (!refreshRequest) operation.createRequest();
    return operation;
  }

  async function handleHttpResponse(operation, response) {
    const headers = {};
    const allowed = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'retry-after', 'access-control-allow-origin', 'vary', 'x-content-type-options', 'allow']);
    for (const [name, value] of Object.entries(response.headers)) {
      if (allowed.has(name.toLowerCase()) && typeof value === 'string' && !/[\r\n\0]/.test(value)) headers[name.toLowerCase()] = value.slice(0, 4096);
    }
    if ((operation.pairRequest || operation.refreshRequest) && response.statusCode >= 200 && response.statusCode < 300) {
      const chunks = []; let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > (operation.refreshRequest ? 64 * 1024 : PEER_MESSAGE_BYTES)) throw new Error('Session response too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, bytes);
      let parsed;
      try { parsed = parseMobilePeerJson(utf8Text(body)); } catch { parsed = null; }
      const token = parsed?.accessToken;
      if (operation.refreshRequest && (parsed?.deviceId !== boundDeviceId || parsed?.authorizationGeneration !== boundGeneration)) {
        throw new Error('Device refresh changed its owner');
      }
      if (typeof token !== 'string' || !await authenticateToken(token, null, { sameFamilyRotation: operation.refreshRequest })) {
        throw new Error('Session authorization unavailable');
      }
      await send({ version: 1, type: 'http.response.start', id: operation.id, status: response.statusCode, headers, bodyLength: body.length });
      for (let offset = 0, seq = 0; offset < body.length; offset += PEER_CHUNK_BYTES, seq += 1) {
        await send({ version: 1, type: 'http.response.chunk', id: operation.id, seq, data: body.subarray(offset, offset + PEER_CHUNK_BYTES).toString('base64') });
      }
      await send({ version: 1, type: 'http.response.end', id: operation.id });
      operations.delete(operation.id); resetIdleTimer(); return;
    }
    const length = responseLength(Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')])));
    await send({ version: 1, type: 'http.response.start', id: operation.id, status: response.statusCode ?? 502, headers, bodyLength: length });
    let total = 0; let seq = 0;
    for await (const chunkValue of response) {
      const chunk = Buffer.from(chunkValue);
      total += chunk.length;
      if (total > PEER_MESSAGE_BYTES) throw new Error('Gateway response too large');
      for (let offset = 0; offset < chunk.length; offset += PEER_CHUNK_BYTES) {
        await send({ version: 1, type: 'http.response.chunk', id: operation.id, seq, data: chunk.subarray(offset, offset + PEER_CHUNK_BYTES).toString('base64') });
        seq += 1;
      }
    }
    if (length !== null && total !== length) throw new Error('Gateway response length mismatch');
    await send({ version: 1, type: 'http.response.end', id: operation.id });
    operations.delete(operation.id); resetIdleTimer();
  }

  async function startWebSocket(frame) {
    if (!authenticated) throw new Error('WebSocket bearer authorization required');
    const url = new URL(frame.path, safeLocalBase(getLocalBase));
    const channelName = url.searchParams.get('channel') || 'runtime';
    const targetId = url.searchParams.get('server') || getDefaultTarget()?.id;
    const rpcCredential = url.searchParams.get('token');
    const bearer = parseBearer(frame.authorization);
    const protocolTokens = frame.protocols.filter(protocol => protocol.startsWith('kcoder-session.'));
    const protocolBearer = protocolTokens.length === 1 ? protocolTokens[0].slice('kcoder-session.'.length) : null;
    if ((!bearer && !protocolBearer) || (bearer && protocolBearer && bearer !== protocolBearer) ||
        rpcCredential !== rpcToken || !allowedChannels.has(channelName) || !targetId) throw new Error('Gateway RPC channel rejected');
    const accessToken = bearer ?? protocolBearer;
    const session = await authenticateToken(accessToken, targetId);
    if (!session || !session.allowedServerIds?.has(targetId)) throw new Error('Gateway target authorization rejected');
    const target = getTarget(targetId);
    if (!target) throw new Error('Gateway target unavailable');
    if (channelName === 'ssh-terminal' && getTargetIds().some(id => !session.allowedServerIds.has(id))) {
      throw new Error('SSH target authorization rejected');
    }
    const protocols = frame.protocols;
    if (!frame.authorization && !protocols.includes('kcoder-studio')) throw new Error('Gateway RPC subprotocol required');
    if (protocolTokens.length > 1 || (protocolBearer && protocolBearer !== accessToken)) throw new Error('Gateway RPC credential conflict');
    const local = safeLocalBase(getLocalBase);
    const wsUrl = new URL(frame.path, local);
    wsUrl.protocol = 'ws:';
    const ws = new WebSocket(wsUrl.toString(), protocols, {
      perMessageDeflate: false,
      maxPayload: PEER_MESSAGE_BYTES,
      handshakeTimeout: 10_000,
      headers: { ...(frame.authorization ? { authorization: frame.authorization } : {}), origin: local.origin },
    });
    const op = {
      kind: 'ws', id: frame.id, ws, opened: false, assemblies: new Map(),
      close() {
        for (const assembly of op.assemblies.values()) {
          activeAssemblies = Math.max(0, activeAssemblies - 1);
          aggregateBytes = Math.max(0, aggregateBytes - assembly.total);
        }
        op.assemblies.clear();
        try { ws.close(1000, 'peer closed'); } catch { ws.terminate?.(); }
        operations.delete(frame.id);
      },
    };
    operations.set(frame.id, op);
    ws.on('open', () => {
      op.opened = true;
      void send({ version: 1, type: 'ws.opened', id: frame.id, protocol: ws.protocol || null }).catch(() => close());
    });
    ws.on('message', (data, isBinary) => {
      void sendWebSocketMessage(op, Buffer.from(data), isBinary).catch(() => { try { ws.close(1009, 'peer message limit'); } catch { ws.terminate?.(); } });
    });
    ws.on('close', (code, reason) => {
      operations.delete(frame.id);
      void send({ version: 1, type: 'ws.closed', id: frame.id, code: validCloseCode(code) ? code : 1000, reason: Buffer.from(reason).toString('utf8').slice(0, 123) }).catch(() => {});
      resetIdleTimer();
    });
    ws.on('error', () => { void failOperation(frame.id, 'ws_failed'); });
    ws.on('ping', data => { try { ws.pong(data); } catch { /* Ignore a closed internal socket. */ } });
    return op;
  }

  function validCloseCode(code) { return Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code); }

  async function sendWebSocketMessage(operation, bytes, binary) {
    if (activeAssemblies >= maximumWsAssemblies || bytes.length > PEER_MESSAGE_BYTES || aggregateBytes + bytes.length > maxAggregateMessageBytes) throw new Error('Gateway WebSocket message too large');
    activeAssemblies += 1;
    aggregateBytes += bytes.length;
    try {
      const messageId = `${operation.id}-${randomMessageId()}`;
      await send({ version: 1, type: 'ws.message.start', id: operation.id, messageId, binary, byteLength: bytes.length });
      let seq = 0;
      for (let offset = 0; offset < bytes.length; offset += PEER_CHUNK_BYTES) {
        await send({ version: 1, type: 'ws.message.chunk', id: operation.id, messageId, seq, data: bytes.subarray(offset, offset + PEER_CHUNK_BYTES).toString('base64') });
        seq += 1;
      }
      await send({ version: 1, type: 'ws.message.end', id: operation.id, messageId });
    } finally {
      activeAssemblies = Math.max(0, activeAssemblies - 1);
      aggregateBytes = Math.max(0, aggregateBytes - bytes.length);
    }
  }

  function randomMessageId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }

  async function handleFrame(frame) {
    resetIdleTimer();
    if (frame.type === 'http.request.start') {
      if (operations.has(frame.id) || operations.size >= PEER_MAX_OPERATIONS) throw new Error('Peer operation limit reached');
      const operation = await makeHttpOperation(frame);
      if (frame.bodyLength === null || frame.bodyLength > 0) return;
      return;
    }
    if (frame.type === 'http.request.chunk') {
      const operation = operations.get(frame.id);
      if (!operation || operation.kind !== 'http' || operation.ended || frame.seq !== operation.seq) throw new Error('Invalid HTTP request chunk');
      const length = decodedPeerChunkBytes(frame.data);
      if (operation.received + length > PEER_MESSAGE_BYTES || (operation.expected !== null && operation.received + length > operation.expected)) throw new Error('HTTP request body limit exceeded');
      const chunk = Buffer.from(frame.data, 'base64');
      operation.received += length; operation.seq += 1;
      if (operation.pairRequest || operation.refreshRequest) {
        if (operation.received > 4096) throw new Error('Pairing body too large');
        operation.pairChunks.push(chunk);
        return;
      }
      if (!operation.req.write(chunk)) await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Gateway request backpressure timeout')), drainTimeoutMs);
        operation.req.once('drain', () => { clearTimeout(timeout); resolve(); });
        operation.req.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      return;
    }
    if (frame.type === 'http.request.end') {
      const operation = operations.get(frame.id);
      if (!operation || operation.kind !== 'http' || operation.ended || (operation.expected !== null && operation.received !== operation.expected)) throw new Error('Invalid HTTP request end');
      operation.ended = true;
      if (operation.pairRequest || operation.refreshRequest) {
        const bodyBytes = Buffer.concat(operation.pairChunks, operation.received);
        let body;
        try { body = parseMobilePeerJson(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)); } catch { throw new Error('Invalid session request JSON'); }
        if (operation.pairRequest) {
          const allowed = new Set(['token', 'durableDeviceAuthorization', 'deviceLabel', 'requestInitialServers']);
          if (!body || body.token !== offerOwnerToken || body.durableDeviceAuthorization !== true ||
              Object.keys(body).some(key => !allowed.has(key)) || typeof body.deviceLabel !== 'string' || body.deviceLabel.length > 80 ||
              (body.requestInitialServers !== undefined && typeof body.requestInitialServers !== 'boolean')) {
            throw new Error('Pairing credential does not match the offer');
          }
          sawPairingRequest = true;
        } else if (!body || Object.keys(body).length !== 3 || body.deviceId !== boundDeviceId ||
            typeof body.refreshToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.refreshToken) ||
            typeof body.rotationId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(body.rotationId) || !refreshOwnerIsCurrent()) {
          throw new Error('Device refresh does not match the peer owner');
        }
        const req = operation.createRequest();
        if (bodyBytes.length) req.write(bodyBytes);
        req.end();
      } else operation.req.end();
      return;
    }
    if (frame.type === 'http.cancel') {
      const operation = operations.get(frame.id);
      if (operation?.kind === 'http') { operation.close(); resetIdleTimer(); }
      return;
    }
    if (frame.type === 'ws.open') {
      if (operations.has(frame.id) || operations.size >= PEER_MAX_OPERATIONS) throw new Error('Peer operation limit reached');
      await startWebSocket(frame); return;
    }
    if (frame.type === 'ws.message.start') {
      const operation = operations.get(frame.id);
      if (!operation || operation.kind !== 'ws' || !operation.opened || operation.assemblies.has(frame.messageId) ||
          activeAssemblies >= maximumWsAssemblies || aggregateBytes + frame.byteLength > maxAggregateMessageBytes) throw new Error('Invalid WebSocket message start');
      operation.assemblies.set(frame.messageId, { bytes: [], length: 0, total: frame.byteLength, seq: 0, binary: frame.binary });
      activeAssemblies += 1; aggregateBytes += frame.byteLength; return;
    }
    if (frame.type === 'ws.message.chunk') {
      const operation = operations.get(frame.id); const assembly = operation?.assemblies.get(frame.messageId);
      if (!assembly || frame.seq !== assembly.seq) throw new Error('Invalid WebSocket message chunk');
      const length = decodedPeerChunkBytes(frame.data);
      if (assembly.length + length > assembly.total) throw new Error('WebSocket message length exceeded');
      assembly.bytes.push(Buffer.from(frame.data, 'base64')); assembly.length += length; assembly.seq += 1; return;
    }
    if (frame.type === 'ws.message.end') {
      const operation = operations.get(frame.id); const assembly = operation?.assemblies.get(frame.messageId);
      if (!assembly || assembly.length !== assembly.total) throw new Error('Invalid WebSocket message end');
      operation.assemblies.delete(frame.messageId);
      activeAssemblies = Math.max(0, activeAssemblies - 1);
      aggregateBytes = Math.max(0, aggregateBytes - assembly.total);
      const payload = Buffer.concat(assembly.bytes, assembly.total);
      if (!assembly.binary && utf8Text(payload) === null) throw new Error('Invalid UTF-8 WebSocket text message');
      operation.ws.send(payload, { binary: assembly.binary }, error => { if (error) void failOperation(operation.id, 'ws_failed'); });
      return;
    }
    if (frame.type === 'ws.close') {
      const operation = operations.get(frame.id);
      if (operation?.kind === 'ws') {
        const code = validCloseCode(frame.code) ? frame.code : 1000;
        try { operation.ws.close(code, frame.reason); } catch { operation.ws.terminate?.(); }
      }
      return;
    }
    if (frame.type === 'error') return;
    throw new Error('Peer frame type is not a client request');
  }

  async function failOperation(id, code) {
    const operation = operations.get(id);
    if (operation) { operation.close?.(); operations.delete(id); }
    await sendError(id, code); resetIdleTimer();
  }

  function attach(value) {
    channel = value;
    channel.setBufferedAmountLowThreshold?.(256 * 1024);
    resetIdleTimer();
  }

  function receive(raw) {
    if (closed) return;
    const bytes = typeof raw === 'string' ? peerUtf8Length(raw) : raw?.byteLength ?? raw?.length ?? 0;
    pendingBytes += bytes; pendingFrames += 1;
    if (pendingBytes > maxQueuedBytes || pendingFrames > 1024 || typeof raw !== 'string') { close(); return; }
    receiveChain = receiveChain.then(async () => {
      let frame;
      try { frame = parsePeerFrame(raw); } catch { close(); return; }
      try { await handleFrame(frame); }
      catch (error) {
        const id = typeof frame.id === 'string' ? frame.id : null;
        if (id && operations.has(id)) await failOperation(id, 'operation_rejected');
        else { await sendError(id, 'frame_rejected'); close(); }
      }
    }).finally(() => { pendingBytes = Math.max(0, pendingBytes - bytes); pendingFrames = Math.max(0, pendingFrames - 1); });
  }

  return { attach, receive, close, get authenticated() { return authenticated; }, get closed() { return closed; },
    get diagnostics() { return { activeAssemblies, aggregateBytes, pendingBytes, pendingFrames, operationCount: operations.size }; } };
}
