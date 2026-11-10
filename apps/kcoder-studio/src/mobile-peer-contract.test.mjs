import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PEER_CHUNK_BYTES,
  PEER_FRAME_BYTES,
  PEER_MESSAGE_BYTES,
  PEER_TRANSPORT_VERSION,
  PEER_ANSWER_SIGNATURE_DOMAIN,
  PEER_OFFER_PROOF_DOMAIN,
  decodedPeerChunkBytes,
  encodePeerFrame,
  isPeerFrame,
  parsePeerFrame,
  peerAnswerSignatureMessage,
  peerOfferProofMessage,
  peerUtf8Length,
} from '../shared/gatewayPeerTransport.js';

const validBearer = `Bearer ${'a'.repeat(32)}`;
const rpcToken = 'r'.repeat(48);

function httpStart({
  id = 'http_1',
  method = 'GET',
  path = '/api/servers',
  headers = { authorization: validBearer },
  bodyLength = 0,
} = {}) {
  return { version: PEER_TRANSPORT_VERSION, type: 'http.request.start', id, method, path, headers, bodyLength };
}

function wsOpen({
  id = 'ws_1',
  path = `/rpc?token=${rpcToken}`,
  authorization = validBearer,
  protocols = ['kcoder-studio'],
} = {}) {
  return { version: PEER_TRANSPORT_VERSION, type: 'ws.open', id, path, authorization, protocols };
}

test('HTTP request frames allow only fixed Mobile, server, and migration operations', () => {
  const deviceId = 'd'.repeat(36);
  const allowed = [
    ['POST', '/api/mobile/session', { headers: { 'content-type': 'application/json' }, bodyLength: 1 }],
    ['DELETE', '/api/mobile/session'],
    ['POST', '/api/mobile/session/refresh', { headers: { 'content-type': 'application/json' }, bodyLength: 1 }],
    ['GET', '/api/mobile/devices'],
    ['DELETE', `/api/mobile/devices/${deviceId}`],
    ['GET', '/api/servers'],
    ['GET', '/api/servers/status'],
    ['POST', '/api/servers/test'],
    ['PUT', '/api/servers/local-1'],
    ['DELETE', '/api/servers/local-1'],
    ['GET', '/api/servers/local-1/cwd-observation'],
    ...['open', 'read', 'close', 'query'].map(operation => ['POST', `/api/migration/source-session/${operation}`]),
    ...[
      'run', 'read', 'cancel', 'target-read', 'target-cancel', 'target-resume', 'target-finish', 'received',
      'adoption-prepare', 'adoption-read', 'adoption-resume', 'adoption-cancel',
    ].map(operation => ['POST', `/api/migration/source-transfer/${operation}`]),
  ];

  for (const [method, path, extra = {}] of allowed) {
    assert.equal(isPeerFrame(httpStart({ method, path, ...extra })), true, `${method} ${path} is a supported Mobile operation`);
  }

  const rejected = [
    ['GET', '/api/admin'],
    ['POST', '/api/admin/users'],
    ['GET', '/api/p2p/signal'],
    ['GET', '/api/mobile/p2p'],
    ['POST', '/api/mobile/p2p/offer'],
    ['GET', '/api/servers/../admin'],
    ['GET', '/api/servers/%2e%2e/admin'],
    ['GET', '/api/servers/%2fadmin'],
    ['GET', '/api/servers/%5cadmin'],
    ['GET', '/api/servers\\local-1'],
    ['GET', '//gateway.example.test/api/servers'],
    ['GET', 'https://gateway.example.test/api/servers'],
    ['GET', '/api/servers#fragment'],
    ['GET', '/api/servers?next=/api/admin'],
    ['GET', '/api/servers?'],
    ['GET', '/api/mobile/session'],
    ['GET', '/api/mobile/session/refresh'],
    ['POST', '/api/mobile/devices'],
    ['GET', `/api/mobile/devices/${deviceId}`],
    ['HEAD', '/api/servers'],
    ['PATCH', '/api/servers/local-1'],
    ['POST', '/api/servers/local-1/cwd-observation'],
    ['GET', '/api/servers/local-1/project-pins'],
    ['PUT', '/api/servers/local-1/project-pins'],
    ['GET', '/api/migration/source-transfer/run'],
    ['POST', '/api/migration/source-session/not-an-operation'],
  ];

  for (const [method, path] of rejected) {
    assert.equal(isPeerFrame(httpStart({ method, path })), false, `${method} ${path} must stay outside the tunnel`);
  }
});

test('HTTP request headers cannot carry cookies, forwarding metadata, or malformed authorization', () => {
  assert.equal(isPeerFrame(httpStart({ headers: {
    authorization: validBearer,
    accept: 'application/json',
    'content-type': 'application/json',
    'if-match': 'revision-4',
  } })), true);

  for (const name of [
    'cookie', 'Cookie', 'set-cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
    'x-forwarded-proto', 'host', 'connection', 'content-length',
  ]) {
    assert.equal(isPeerFrame(httpStart({ headers: { authorization: validBearer, [name]: 'untrusted' } })), false, `${name} is not tunnelable`);
  }

  for (const path of ['/api/mobile/session', '/api/mobile/session/refresh']) {
    assert.equal(isPeerFrame(httpStart({ method: 'POST', path, headers: { 'content-type': 'application/json' }, bodyLength: 1 })), true);
    assert.equal(isPeerFrame(httpStart({ method: 'POST', path, headers: { authorization: validBearer, 'content-type': 'application/json' }, bodyLength: 1 })), false);
  }

  for (const authorization of [
    'Basic abcdefghijklmnopqrstuvwxyz012345',
    'Bearer short',
    `Bearer ${'a'.repeat(31)}`,
    `Bearer ${'a'.repeat(129)}`,
    `Bearer ${'a'.repeat(31)}.${'b'.repeat(32)}`,
    `${validBearer}\r\nCookie: session=stolen`,
  ]) {
    assert.equal(isPeerFrame(httpStart({ headers: { authorization } })), false);
  }
  assert.equal(isPeerFrame(httpStart({ headers: { accept: 'application/json' } })), false);
});

test('WebSocket frames are limited to authenticated /rpc query and protocol forms', () => {
  const authorizedRpc = wsOpen({
    path: `/rpc?channel=runtime&token=${rpcToken}&server=local-1&workspace=%2Fwork`,
  });
  assert.equal(isPeerFrame(authorizedRpc), true);
  assert.deepEqual(parsePeerFrame(encodePeerFrame(authorizedRpc)), authorizedRpc);
  assert.equal(isPeerFrame(wsOpen({ protocols: [] })), true, 'native Bearer authentication can use the Gateway default protocol');
  assert.equal(isPeerFrame(wsOpen({ path: `/rpc?token=${'t'.repeat(256)}` })), true);
  assert.equal(isPeerFrame(wsOpen({ authorization: `Bearer ${'b'.repeat(128)}`, protocols: [] })), true);

  const sessionToken = `kcoder-session.${'a'.repeat(32)}`;
  assert.equal(isPeerFrame(wsOpen({ authorization: null, protocols: ['kcoder-studio', sessionToken] })), true);
  assert.equal(isPeerFrame(wsOpen({ authorization: validBearer, protocols: ['kcoder-studio', sessionToken] })), true);
  assert.equal(isPeerFrame(wsOpen({ authorization: null, protocols: [sessionToken] })), false);
  assert.equal(isPeerFrame(wsOpen({ authorization: null, protocols: ['kcoder-studio'] })), false);
  assert.equal(isPeerFrame(wsOpen({
    authorization: validBearer,
    protocols: ['kcoder-studio', `kcoder-session.${'b'.repeat(32)}`],
  })), false, 'the Authorization bearer and session carrier cannot name different credentials');

  for (const path of [
    '/rpc',
    `/rpc?token=${rpcToken}&token=${rpcToken}`,
    `/rpc?token=${rpcToken}&channel=runtime&channel=browser`,
    `/rpc?token=${rpcToken}&admin=true`,
    `/rpc?token=${'t'.repeat(257)}`,
    '/rpc?token=valid&unused=',
    `/rpc/?token=${rpcToken}`,
    `/rpc/../rpc?token=${rpcToken}`,
    `/rpc/%2e%2e/rpc?token=${rpcToken}`,
    `//gateway.example.test/rpc?token=${rpcToken}`,
    `https://gateway.example.test/rpc?token=${rpcToken}`,
    `/rpc?token=${rpcToken}#fragment`,
  ]) {
    assert.equal(isPeerFrame(wsOpen({ path })), false, `${path} must not open a tunneled WebSocket`);
  }

  for (const authorization of [
    'Basic abcdefghijklmnopqrstuvwxyz012345',
    'Bearer short',
    `Bearer ${'b'.repeat(129)}`,
    `Bearer ${'b'.repeat(31)}.${'c'.repeat(32)}`,
    `Bearer ${'b'.repeat(31)}\r\nX-Forwarded-For: 127.0.0.1`,
  ]) {
    assert.equal(isPeerFrame(wsOpen({ authorization })), false);
  }

  for (const protocols of [
    ['graphql-transport-ws'],
    ['kcoder-studio', 'kcoder-studio'],
    ['kcoder-studio', 'kcoder-session.short'],
    ['kcoder-studio', 'kcoder-session.' + 'x'.repeat(129)],
    ['kcoder-studio', 'kcoder-session.' + 'x'.repeat(32), 'kcoder-studio'],
  ]) {
    assert.equal(isPeerFrame(wsOpen({ protocols })), false);
  }

  assert.equal(isPeerFrame(wsOpen({
    authorization: null,
    protocols: ['kcoder-studio', `kcoder-session.${'x'.repeat(32)}`, `kcoder-session.${'y'.repeat(32)}`],
  })), false, 'an unauthenticated open cannot offer two session credentials');
});

test('frame identifiers and schemas reject non-string request IDs and undeclared fields', () => {
  assert.equal(isPeerFrame(httpStart({ id: 7 })), false);
  assert.equal(isPeerFrame(wsOpen({ id: 7 })), false);
  assert.equal(isPeerFrame({ version: 1, type: 'error', id: 7, code: 'bad_frame' }), false);
  assert.equal(isPeerFrame({ version: 1, type: 'error', id: null, code: 'bad_frame' }), true);
  assert.equal(isPeerFrame(httpStart({ id: '' })), false);
  assert.equal(isPeerFrame(httpStart({ id: 'request.id' })), false);
  assert.equal(isPeerFrame({ ...httpStart(), unexpected: true }), false);

  const messageStart = {
    version: 1,
    type: 'ws.message.start',
    id: 'ws_1',
    messageId: 'message_1',
    binary: false,
    byteLength: 0,
  };
  assert.equal(isPeerFrame(messageStart), true);
  assert.equal(isPeerFrame({ ...messageStart, messageId: 42 }), false);
  assert.equal(isPeerFrame({ ...messageStart, messageId: '' }), false);
});

test('base64 chunks and assembled messages stay within their byte limits', () => {
  const makeChunk = (data, seq = 0) => ({
    version: 1,
    type: 'http.request.chunk',
    id: 'http_1',
    seq,
    data,
  });
  const fullChunk = Buffer.alloc(PEER_CHUNK_BYTES, 0xa7).toString('base64');
  assert.equal(decodedPeerChunkBytes(fullChunk), PEER_CHUNK_BYTES);
  assert.equal(isPeerFrame(makeChunk(fullChunk)), true);
  assert.equal(isPeerFrame(makeChunk(Buffer.alloc(PEER_CHUNK_BYTES + 1).toString('base64'))), false);

  for (const invalidBase64 of ['', 'A', 'YQ=', 'YQ===', 'not base64!']) {
    assert.equal(isPeerFrame(makeChunk(invalidBase64)), false);
    assert.throws(() => decodedPeerChunkBytes(invalidBase64), TypeError);
  }

  assert.equal(isPeerFrame(makeChunk('AA==', 1_999_999)), true);
  assert.equal(isPeerFrame(makeChunk('AA==', 2_000_000)), false);
  assert.equal(isPeerFrame(makeChunk('AA==', -1)), false);

  assert.equal(isPeerFrame(httpStart({ bodyLength: PEER_MESSAGE_BYTES })), true);
  assert.equal(isPeerFrame(httpStart({ bodyLength: PEER_MESSAGE_BYTES + 1 })), false);
  const wsMessage = { version: 1, type: 'ws.message.start', id: 'ws_1', messageId: 'message_1', binary: true, byteLength: PEER_MESSAGE_BYTES };
  assert.equal(isPeerFrame(wsMessage), true);
  assert.equal(isPeerFrame({ ...wsMessage, byteLength: PEER_MESSAGE_BYTES + 1 }), false);
  assert.equal(isPeerFrame({ ...wsMessage, byteLength: null }), false);
  assert.equal(isPeerFrame({ ...wsMessage, byteLength: 0 }), true);
});

test('UTF-8 text survives arbitrary chunk boundaries and frame limits count encoded bytes', () => {
  const source = `${'a'.repeat(PEER_CHUNK_BYTES - 1)}😀${'🌍é漢'.repeat(120)}`;
  const bytes = Buffer.from(source, 'utf8');
  assert.equal(peerUtf8Length(source), Buffer.byteLength(source, 'utf8'));
  assert.equal(peerUtf8Length('🧪'), 4);

  const frames = [{
    version: 1,
    type: 'ws.message.start',
    id: 'ws_1',
    messageId: 'unicode_1',
    binary: false,
    byteLength: bytes.byteLength,
  }];
  for (let offset = 0, seq = 0; offset < bytes.byteLength; offset += PEER_CHUNK_BYTES, seq += 1) {
    frames.push({
      version: 1,
      type: 'ws.message.chunk',
      id: 'ws_1',
      messageId: 'unicode_1',
      seq,
      data: bytes.subarray(offset, Math.min(offset + PEER_CHUNK_BYTES, bytes.byteLength)).toString('base64'),
    });
  }
  frames.push({ version: 1, type: 'ws.message.end', id: 'ws_1', messageId: 'unicode_1' });

  const decodedFrames = frames.map(frame => parsePeerFrame(encodePeerFrame(frame)));
  assert.deepEqual(decodedFrames, frames);
  const chunkBytes = decodedFrames
    .filter(frame => frame.type === 'ws.message.chunk')
    .map(frame => Buffer.from(frame.data, 'base64'));
  assert.equal(chunkBytes[0].at(-1), 0xf0, 'the first chunk ends inside the next four-byte code point');
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(chunkBytes[0]), TypeError);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunkBytes)), source);

  const largeHeaderValue = `${'😀'.repeat(2047)}aa`;
  const oversizedUnicodeFrame = {
    version: 1,
    type: 'http.response.start',
    id: 'unicode_frame',
    status: 200,
    headers: { 'content-type': largeHeaderValue, 'cache-control': largeHeaderValue },
    bodyLength: 0,
  };
  assert.equal(isPeerFrame(oversizedUnicodeFrame), true);
  const raw = JSON.stringify(oversizedUnicodeFrame);
  assert.ok(raw.length < PEER_FRAME_BYTES);
  assert.ok(peerUtf8Length(raw) > PEER_FRAME_BYTES);
  assert.throws(() => encodePeerFrame(oversizedUnicodeFrame), RangeError);
  assert.throws(() => parsePeerFrame(raw), TypeError);
});

test('offer proof and answer signature messages bind separate domains, nonce, hash, and exact answer', () => {
  const gatewayId = 'g'.repeat(64);
  const nonce = '0123456789abcdef'.repeat(3);
  const offer = 'v=0\r\no=- client offer\r\n';
  const offerHash = createHash('sha256').update(offer, 'utf8').digest('hex');
  const answer = 'v=0\r\no=- gateway answer 😀\r\n';

  const offerMessage = peerOfferProofMessage(gatewayId, nonce, offerHash);
  const answerMessage = peerAnswerSignatureMessage(gatewayId, nonce, offerHash, answer);
  assert.equal(PEER_OFFER_PROOF_DOMAIN, 'kcoder.gateway.peer-offer.v1');
  assert.equal(PEER_ANSWER_SIGNATURE_DOMAIN, 'kcoder.gateway.peer-answer.v1');
  assert.equal(offerMessage, JSON.stringify([PEER_OFFER_PROOF_DOMAIN, gatewayId, nonce, offerHash]));
  assert.equal(answerMessage, JSON.stringify([PEER_ANSWER_SIGNATURE_DOMAIN, gatewayId, nonce, offerHash, answer]));
  assert.notEqual(offerMessage, answerMessage);
  assert.notEqual(peerOfferProofMessage(gatewayId, `${nonce.slice(0, -1)}e`, offerHash), offerMessage);
  assert.notEqual(peerOfferProofMessage(gatewayId, nonce, `${offerHash.slice(0, -1)}0`), offerMessage);
  assert.notEqual(peerAnswerSignatureMessage(gatewayId, nonce, offerHash, `${answer} `), answerMessage);
});
