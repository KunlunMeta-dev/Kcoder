export const PEER_TRANSPORT_VERSION = 1;
export const PEER_FRAME_BYTES = 16 * 1024;
export const PEER_CHUNK_BYTES = 8 * 1024;
export const PEER_MESSAGE_BYTES = 16 * 1024 * 1024;
export const PEER_MAX_OPERATIONS = 8;
export const PEER_BUFFER_HIGH_WATERMARK = 1024 * 1024;
export const PEER_CHANNEL_LABEL = 'kcoder-gateway-v1';
export const PEER_OFFER_PROOF_DOMAIN = 'kcoder.gateway.peer-offer.v1';
export const PEER_ANSWER_SIGNATURE_DOMAIN = 'kcoder.gateway.peer-answer.v1';

const requestId = /^[A-Za-z0-9_-]{1,96}$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const allowedHttpMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const allowedHeaders = new Set(['authorization', 'content-type', 'accept', 'if-match', 'if-none-match', 'range', 'content-range']);
const allowedResponseHeaders = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'retry-after', 'access-control-allow-origin', 'vary', 'x-content-type-options', 'allow']);
const allowedWebSocketProtocols = new Set(['kcoder-studio']);
const frameFields = {
  'http.request.start': ['version', 'type', 'id', 'method', 'path', 'headers', 'bodyLength'],
  'http.request.chunk': ['version', 'type', 'id', 'seq', 'data'],
  'http.request.end': ['version', 'type', 'id'],
  'http.cancel': ['version', 'type', 'id'],
  'http.response.start': ['version', 'type', 'id', 'status', 'headers', 'bodyLength'],
  'http.response.chunk': ['version', 'type', 'id', 'seq', 'data'],
  'http.response.end': ['version', 'type', 'id'],
  'ws.open': ['version', 'type', 'id', 'path', 'authorization', 'protocols'],
  'ws.opened': ['version', 'type', 'id', 'protocol'],
  'ws.message.start': ['version', 'type', 'id', 'messageId', 'binary', 'byteLength'],
  'ws.message.chunk': ['version', 'type', 'id', 'messageId', 'seq', 'data'],
  'ws.message.end': ['version', 'type', 'id', 'messageId'],
  'ws.close': ['version', 'type', 'id', 'code', 'reason'],
  'ws.closed': ['version', 'type', 'id', 'code', 'reason'],
  error: ['version', 'type', 'id', 'code'],
};

export function peerUtf8Length(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function peerOfferProofMessage(gatewayId, nonce, offerHash) {
  return JSON.stringify([PEER_OFFER_PROOF_DOMAIN, gatewayId, nonce, offerHash]);
}

export function peerAnswerSignatureMessage(gatewayId, nonce, offerHash, answer) {
  return JSON.stringify([PEER_ANSWER_SIGNATURE_DOMAIN, gatewayId, nonce, offerHash, answer]);
}

function originForm(value, pathname) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('#')) return false;
  const rawPath = value.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(rawPath)) return false;
  let parsed;
  try { parsed = new URL(value, 'http://127.0.0.1'); } catch { return false; }
  if (parsed.origin !== 'http://127.0.0.1' || parsed.username || parsed.password || parsed.hash) return false;
  let segments;
  try { segments = rawPath.split('/').map(part => decodeURIComponent(part)); } catch { return false; }
  if (segments.some(part => part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) return false;
  if (pathname === 'api') return parsed.pathname.startsWith('/api/') && parsed.pathname.length > 5;
  if (pathname === 'rpc') return parsed.pathname === '/rpc' && allowedRpcQuery(parsed.searchParams);
  return false;
}

function allowedRpcQuery(params) {
  const allowed = new Set(['channel', 'token', 'server', 'workspace']);
  const seen = new Set();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return params.getAll('token').length === 1 && params.get('token')?.length <= 256;
}

function validBearer(value) {
  return typeof value === 'string' && /^Bearer [A-Za-z0-9-]{32,128}$/.test(value);
}

function validHeaders(value, { requireBearer = false, response = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 7) return false;
  for (const [name, content] of Object.entries(value)) {
    if (!(response ? allowedResponseHeaders : allowedHeaders).has(name) || typeof content !== 'string' || content.length > 4096 || /[\r\n\0]/.test(content)) return false;
  }
  return !requireBearer || validBearer(value.authorization);
}

function validPayload(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(PEER_CHUNK_BYTES / 3) * 4 || !base64.test(data)) return false;
  const decoded = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  return decoded > 0 && decoded <= PEER_CHUNK_BYTES;
}

function validSequence(value) { return Number.isSafeInteger(value) && value >= 0 && value < 2_000_000; }
function validByteLength(value) { return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= PEER_MESSAGE_BYTES); }
function validWsProtocols(value) {
  return Array.isArray(value) && value.length <= 2 && value.every(protocol =>
    typeof protocol === 'string' && (allowedWebSocketProtocols.has(protocol) || /^kcoder-session\.[A-Za-z0-9-]{32,128}$/.test(protocol))) &&
    new Set(value).size === value.length &&
    value.filter(protocol => protocol.startsWith('kcoder-session.')).length <= 1;
}

function validRequestPath(method, path) {
  if (path.includes('?') || !originForm(path, 'api')) return false;
  let pathname;
  try {
    const parsed = new URL(path, 'http://127.0.0.1');
    if (parsed.search) return false;
    pathname = parsed.pathname;
  } catch { return false; }
  if (pathname === '/api/mobile/session') return method === 'POST' || method === 'DELETE';
  if (pathname === '/api/mobile/session/refresh') return method === 'POST';
  if (pathname === '/api/mobile/devices') return method === 'GET';
  if (/^\/api\/mobile\/devices\/[A-Za-z0-9-]{16,128}$/.test(pathname)) return method === 'DELETE';
  if (pathname === '/api/servers') return method === 'GET';
  if (pathname === '/api/servers/status') return method === 'GET';
  if (pathname === '/api/servers/test') return method === 'POST';
  if (/^\/api\/migration\/source-session\/(?:open|read|close|query)$/.test(pathname)) return method === 'POST';
  if (/^\/api\/migration\/source-transfer\/(?:run|read|cancel|target-read|target-cancel|target-resume|target-finish|received|adoption-prepare|adoption-read|adoption-resume|adoption-cancel)$/.test(pathname)) return method === 'POST';
  if (/^\/api\/servers\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/cwd-observation$/.test(pathname)) return method === 'GET';
  if (/^\/api\/servers\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pathname)) return method === 'PUT' || method === 'DELETE';
  return false;
}

export function isPeerFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== PEER_TRANSPORT_VERSION || typeof value.type !== 'string') return false;
  const fields = frameFields[value.type];
  if (!fields || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) return false;
  if (value.type === 'error') return (value.id === null || (typeof value.id === 'string' && requestId.test(value.id))) && /^[a-z][a-z0-9_]{0,63}$/.test(value.code);
  if (value.type.startsWith('http.')) {
    if (typeof value.id !== 'string' || !requestId.test(value.id)) return false;
    if (value.type === 'http.request.start') {
      if (!allowedHttpMethods.has(value.method) || !validRequestPath(value.method, value.path) || !validByteLength(value.bodyLength)) return false;
      const unauthenticatedBootstrap = value.method === 'POST' && ['/api/mobile/session', '/api/mobile/session/refresh'].includes(value.path);
      return validHeaders(value.headers, { requireBearer: !unauthenticatedBootstrap }) &&
        (!unauthenticatedBootstrap || value.headers.authorization === undefined);
    }
    if (value.type === 'http.response.start') return Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 && validHeaders(value.headers, { response: true }) && validByteLength(value.bodyLength);
    if (value.type.endsWith('.chunk')) return validSequence(value.seq) && validPayload(value.data);
    return true;
  }
  if (value.type.startsWith('ws.')) {
    if (typeof value.id !== 'string' || !requestId.test(value.id)) return false;
    if (value.type === 'ws.open') {
      if (!originForm(value.path, 'rpc') || (value.authorization !== null && !validBearer(value.authorization)) || !validWsProtocols(value.protocols)) return false;
      const carrier = value.protocols.find(protocol => protocol.startsWith('kcoder-session.'));
      if (value.authorization === null) return Boolean(carrier && value.protocols.includes('kcoder-studio'));
      if (carrier && !value.protocols.includes('kcoder-studio')) return false;
      return !carrier || value.authorization === `Bearer ${carrier.slice('kcoder-session.'.length)}`;
    }
    if (value.type === 'ws.opened') return value.protocol === null || (typeof value.protocol === 'string' && value.protocol.length <= 128);
    if (value.type === 'ws.message.start') return typeof value.messageId === 'string' && requestId.test(value.messageId) && typeof value.binary === 'boolean' && validByteLength(value.byteLength) && value.byteLength !== null;
    if (value.type === 'ws.message.chunk') return typeof value.messageId === 'string' && requestId.test(value.messageId) && validSequence(value.seq) && validPayload(value.data);
    if (value.type === 'ws.message.end') return typeof value.messageId === 'string' && requestId.test(value.messageId);
    if (value.type === 'ws.close' || value.type === 'ws.closed') return Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999 && ![1004, 1005, 1006, 1015].includes(value.code) && typeof value.reason === 'string' && value.reason.length <= 123;
    return true;
  }
  return false;
}

export function encodePeerFrame(value) {
  if (!isPeerFrame(value)) throw new TypeError('Invalid Gateway peer transport frame');
  const raw = JSON.stringify(value);
  if (peerUtf8Length(raw) > PEER_FRAME_BYTES) throw new RangeError('Gateway peer frame is too large');
  return raw;
}

export function parsePeerFrame(raw) {
  if (typeof raw !== 'string' || peerUtf8Length(raw) > PEER_FRAME_BYTES) throw new TypeError('Invalid Gateway peer transport frame');
  let value;
  try { value = JSON.parse(raw); } catch { throw new TypeError('Invalid Gateway peer transport frame'); }
  if (!isPeerFrame(value)) throw new TypeError('Invalid Gateway peer transport frame');
  return value;
}

export function decodedPeerChunkBytes(value) {
  if (!validPayload(value)) throw new TypeError('Invalid Gateway peer transport chunk');
  return value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}
