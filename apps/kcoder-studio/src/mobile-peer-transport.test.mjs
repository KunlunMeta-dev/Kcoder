import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { peerOfferProofMessage } from '../shared/gatewayPeerTransport.js';
import { createMobilePeerTransport, sanitizePeerOfferCandidates } from './mobile-peer-transport.js';

const gatewayId = 'gateway-test';
const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const offer = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 2122260223 1.1.1.1 50000 typ srflx raddr 0.0.0.0 rport 0\r\n';
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function pairingAuth(token, nonce, sdp = offer) {
  const offerHash = sha256(sdp);
  return {
    version: 1,
    nonce,
    offer: sdp,
    auth: {
      kind: 'pairing',
      keyId: sha256(token),
      proof: createHmac('sha256', Buffer.from(token, 'utf8'))
        .update(peerOfferProofMessage(gatewayId, nonce, offerHash), 'utf8').digest('hex'),
    },
  };
}

function responseCapture() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; },
  };
}

function postRequest(payload, remoteAddress = '203.0.113.10') {
  const body = Buffer.from(JSON.stringify(payload));
  const request = Readable.from([body]);
  request.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
  request.method = 'POST';
  request.url = '/api/mobile/p2p/offer';
  request.socket = { remoteAddress };
  return request;
}

function fakeRtc({ autoAnswer = true, onPeer = () => {} } = {}) {
  const peers = [];
  class FakePeerConnection {
    constructor(id, config) {
      this.id = id;
      this.config = config;
      this.gathering = 'New';
      peers.push(this);
      onPeer(this);
    }
    onLocalDescription(callback) { this.localDescriptionCallback = callback; }
    onGatheringStateChange(callback) { this.gatheringCallback = callback; }
    onStateChange(callback) { this.stateCallback = callback; }
    onDataChannel() {}
    gatheringState() { return this.gathering; }
    localDescription() { return this.local; }
    setRemoteDescription(sdp, type) {
      this.remoteSdp = sdp;
      this.remoteType = type;
      if (autoAnswer) queueMicrotask(() => this.completeAnswer());
    }
    completeAnswer() {
      this.local = { type: 'Answer', sdp: answer };
      this.gathering = 'Complete';
      this.localDescriptionCallback?.(answer, 'Answer');
      this.gatheringCallback?.('Complete');
    }
    close() { this.stateCallback?.('Closed'); }
  }
  return { rtc: { PeerConnection: FakePeerConnection }, peers };
}

function makeTransport({ tokens = ['pairing-credential-A'], webToken, allowsSurface, loadRtc, loadWebSocket, rtcOptions, timeoutMs } = {}) {
  const { rtc, peers } = fakeRtc(rtcOptions);
  const credentialSet = new Set(tokens);
  const mobileDeviceAuth = {
    async getPeerPairingCredentialForProof(nonce, offerHash, keyId, proof) {
      for (const token of credentialSet) {
        const expected = createHmac('sha256', Buffer.from(token, 'utf8'))
          .update(peerOfferProofMessage(gatewayId, nonce, offerHash), 'utf8').digest('hex');
        if (sha256(token) === keyId && expected === proof) return token;
      }
      return null;
    },
    async signPeerAnswer() { return 'f'.repeat(128); },
    async matchesPairingCredential(token, surface) { return token === webToken && surface === 'mobileWeb'; },
  };
  const transport = createMobilePeerTransport({
    enabled: true,
    stunUrls: 'stun:stun.example.test:3478',
    mobileDeviceAuth,
    getIdentity: async () => ({ gatewayId }),
    jsonResponse(response, status, value) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    },
    getLocalBase: () => 'http://127.0.0.1:4175/',
    rpcToken: 'internal-rpc-token',
    authSessionById: async () => null,
    authSessions: new Map(),
    mobileDeviceFamilies: new Map(),
    ownership: { async bind() { return null; }, close() {} },
    allowsSurface,
    loadRtc: loadRtc ?? (() => Promise.resolve(rtc)),
    loadWebSocket: loadWebSocket ?? (() => Promise.resolve(class FakeWebSocket {})),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { transport, peers };
}

async function submit(transport, payload, remoteAddress) {
  const response = responseCapture();
  await transport.handleHttp(postRequest(payload, remoteAddress), response, new URL('http://gateway.test/api/mobile/p2p/offer'));
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

test('disabling App public access closes its peer and leaves the Web peer active', async t => {
  const appToken = 'pairing-credential-A', webToken = 'pairing-credential-Web';
  let appAllowed = true;
  const { transport } = makeTransport({ tokens: [appToken, webToken], webToken,
    allowsSurface: surface => surface === 'mobileWeb' || appAllowed });
  t.after(() => transport.close());
  assert.equal((await submit(transport, pairingAuth(appToken, 'a'.repeat(48)))).status, 200);
  const webOffer = pairingAuth(webToken, 'b'.repeat(48));
  assert.equal((await submit(transport, webOffer)).status, 200);
  assert.equal(transport.peerCount, 2);
  appAllowed = false;
  transport.closeDisabled();
  assert.equal(transport.peerCount, 1);
  assert.equal((await submit(transport, pairingAuth(appToken, 'c'.repeat(48)))).status, 403);
  assert.equal((await submit(transport, webOffer)).status, 200);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('candidate filtering keeps same-subnet host and usable srflx while dropping unsafe host candidates', () => {
  const mixed = `${offer}a=candidate:2 1 udp 2122260222 phone-a.local 50001 typ host\r\na=candidate:3 1 udp 2122260221 192.168.10.9 50002 typ host\r\na=candidate:4 1 udp 2122260220 127.0.0.1 50003 typ host\r\na=candidate:5 1 udp 2122260219 192.168.10.255 50004 typ host\r\na=candidate:6 1 udp 2122260218 192.168.20.9 50005 typ host\r\na=candidate:7 1 udp 2122260217 224.0.0.1 50006 typ host\r\n`;
  const sanitized = sanitizePeerOfferCandidates(mixed, ['192.168.10.0/24']);
  assert.ok(sanitized);
  assert.match(sanitized, /1\.1\.1\.1 50000 typ srflx/);
  assert.match(sanitized, /192\.168\.10\.9 50002 typ host/);
  assert.doesNotMatch(sanitized, /phone-a\.local|127\.0\.0\.1|192\.168\.10\.255|192\.168\.20\.9|224\.0\.0\.1/);
  assert.match(sanitizePeerOfferCandidates(`${offer}a=candidate:8 1 udp 2122260216 192.168.10.255 50007 typ host\r\n`, ['192.168.10.254/31']), /192\.168\.10\.255 50007 typ host/);
  assert.match(sanitizePeerOfferCandidates(`${offer}a=candidate:9 1 udp 2122260215 192.168.10.255 50008 typ host\r\n`, ['192.168.10.255/32']), /192\.168\.10\.255 50008 typ host/);
});

test('HMAC and answer hash bind raw offer bytes while only safe candidates reach native WebRTC', async t => {
  const mixedOffer = `${offer}a=candidate:2 1 udp 2122260222 phone-a.local 50001 typ host\r\n`;
  const { transport, peers } = makeTransport();
  t.after(() => transport.close());
  const payload = pairingAuth('pairing-credential-A', 'd'.repeat(48), mixedOffer);
  const result = await submit(transport, payload);
  assert.equal(result.status, 200);
  assert.equal(result.body.offerHash, sha256(mixedOffer));
  assert.match(peers[0].remoteSdp, /1\.1\.1\.1 50000 typ srflx/);
  assert.doesNotMatch(peers[0].remoteSdp, /phone-a\.local/);
});

test('bad offer HMAC is rejected before constructing a PeerConnection', async t => {
  const { transport, peers } = makeTransport();
  t.after(() => transport.close());
  const payload = pairingAuth('pairing-credential-A', 'a'.repeat(48));
  payload.auth.proof = '0'.repeat(64);
  const result = await submit(transport, payload);
  assert.equal(result.status, 401);
  assert.equal(peers.length, 0);
});

test('same nonce and offer concurrently await one signed answer and create one native peer', async t => {
  const loading = deferred();
  const { transport, peers } = makeTransport({ loadWebSocket: () => loading.promise });
  t.after(() => transport.close());
  const payload = pairingAuth('pairing-credential-A', 'b'.repeat(48));
  const first = submit(transport, payload, '203.0.113.11');
  while (transport.peerCount !== 0) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const second = submit(transport, payload, '203.0.113.12');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peers.length, 0);
  loading.resolve(class FakeWebSocket {});
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  assert.deepEqual(right.body, left.body);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].remoteType, 'Offer');
  assert.equal(typeof peers[0].setLocalDescription, 'undefined');
  assert.equal(left.body.answer, answer);
  assert.equal(left.body.offerHash, sha256(offer));
});

test('closing during native addon load rejects the offer and cannot allocate an orphan peer', async () => {
  const loading = deferred();
  const { transport, peers } = makeTransport({ loadRtc: () => loading.promise });
  const payload = pairingAuth('pairing-credential-A', 'c'.repeat(48));
  const pending = submit(transport, payload);
  await new Promise(resolve => setImmediate(resolve));
  await transport.close();
  loading.resolve({ PeerConnection: class UnexpectedPeer {} });
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal(peers.length, 0);
  assert.equal(transport.peerCount, 0);
});

test('sixteen authenticated peer slots are admitted atomically and the seventeenth is rejected', async t => {
  const { transport, peers } = makeTransport({
    tokens: Array.from({ length: 17 }, (_, index) => `pairing-credential-${index}`),
    rtcOptions: { autoAnswer: false },
  });
  t.after(() => transport.close());
  const requests = Array.from({ length: 17 }, (_, index) => {
    const token = `pairing-credential-${index}`;
    const nonce = (index + 1).toString(16).padStart(48, '0');
    return submit(transport, pairingAuth(token, nonce), `203.0.113.${index + 1}`);
  });
  while (peers.length < 16) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peers.length, 16);
  for (const peer of peers) peer.completeAnswer();
  const results = await Promise.all(requests);
  assert.equal(results.filter(result => result.status === 200).length, 16);
  assert.equal(results.filter(result => result.status === 429).length, 1);
  assert.equal(peers.length, 16);
});

test('global pending signal-body gate caps slow concurrent callers and shutdown releases them', async () => {
  const { transport } = makeTransport();
  const pending = [];
  for (let index = 0; index < 32; index += 1) {
    const request = new PassThrough();
    request.headers = { 'content-type': 'application/json' };
    request.method = 'POST'; request.url = '/api/mobile/p2p/offer';
    request.socket = { remoteAddress: `203.0.113.${index + 1}` };
    const response = responseCapture();
    pending.push({ promise: transport.handleHttp(request, response, new URL('http://gateway.test/api/mobile/p2p/offer')), response });
  }
  const excessRequest = postRequest(pairingAuth('pairing-credential-A', 'e'.repeat(48)), '203.0.113.90');
  const excessResponse = responseCapture();
  await transport.handleHttp(excessRequest, excessResponse, new URL('http://gateway.test/api/mobile/p2p/offer'));
  assert.equal(excessResponse.status, 429);
  await transport.close();
  await Promise.all(pending.map(item => item.promise));
});

test('oversized and timed-out signal bodies destroy their request streams before releasing admission', async () => {
  const { transport } = makeTransport({ timeoutMs: 25 });
  const keepTestProcessAlive = setTimeout(() => {}, 1_000);
  try {
    const tooLarge = new PassThrough();
    tooLarge.headers = { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) };
    tooLarge.method = 'POST'; tooLarge.url = '/api/mobile/p2p/offer'; tooLarge.socket = { remoteAddress: '203.0.113.101' };
    const oversizedResponse = responseCapture();
    await transport.handleHttp(tooLarge, oversizedResponse, new URL('http://gateway.test/api/mobile/p2p/offer'));
    assert.equal(oversizedResponse.status, 413);
    assert.equal(tooLarge.destroyed, true);

    const slow = new PassThrough();
    slow.headers = { 'content-type': 'application/json' };
    slow.method = 'POST'; slow.url = '/api/mobile/p2p/offer'; slow.socket = { remoteAddress: '203.0.113.101' };
    const slowResponse = responseCapture();
    await transport.handleHttp(slow, slowResponse, new URL('http://gateway.test/api/mobile/p2p/offer'));
    assert.equal(slowResponse.status, 408);
    assert.equal(slow.destroyed, true);
  } finally {
    clearTimeout(keepTestProcessAlive);
  }
  await transport.close();
});
