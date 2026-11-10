import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileWebCors } from './mobile-web-cors.js';

test('connection proof uses the existing explicit Mobile CORS allowlist', () => {
  const responses = [];
  const cors = createMobileWebCors({
    mobileWebOrigins: new Set(['https://mobile.example.test']),
    isAllowedOrigin: (origin, host) => origin === `https://${host}`,
    jsonResponse: (_response, status, payload) => responses.push({ status, payload }),
  });
  assert.equal(cors.isMobileApiPath('/api/mobile/connection-proof'), true);

  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead() {}, end() {} };
  const allowed = cors.applyMobileCors({ method: 'GET', headers: { origin: 'https://mobile.example.test', host: 'gateway.example.test' } }, response, '/api/mobile/connection-proof');
  assert.deepEqual(allowed, { handled: false, allowed: true });
  assert.equal(response.headers['access-control-allow-origin'], 'https://mobile.example.test');

  const denied = cors.applyMobileCors({ method: 'GET', headers: { origin: 'https://unlisted.example.test', host: 'gateway.example.test' } }, response, '/api/mobile/connection-proof');
  assert.deepEqual(denied, { handled: false, allowed: false });
  const preflight = cors.applyMobileCors({ method: 'OPTIONS', headers: { origin: 'https://unlisted.example.test', host: 'gateway.example.test' } }, response, '/api/mobile/connection-proof');
  assert.deepEqual(preflight, { handled: true, allowed: false });
  assert.equal(responses[0].status, 403);
});


const origin = 'https://mobile-owned.example.invalid';
const cors = () => createMobileWebCors({ mobileWebOrigins: new Set([origin]), isAllowedOrigin: () => false, jsonResponse: (res, status) => { res.status = status; } });
test('only reviewed migration routes enter the explicitly allowed Mobile origin gate', () => {
  const gate = cors();
  for (const name of ['open', 'read', 'close', 'query']) assert.equal(gate.isMobileApiPath(`/api/migration/source-session/${name}`), true);
  for (const name of ['run', 'read', 'cancel', 'target-read', 'target-cancel', 'target-resume', 'target-finish', 'received', 'adoption-prepare', 'adoption-read', 'adoption-resume', 'adoption-cancel']) assert.equal(gate.isMobileApiPath(`/api/migration/source-transfer/${name}`), true);
  for (const path of ['/api/migration', '/api/rpc', '/api/migration/source-session/arbitrary', '/api/migration/source-transfer/custom', '/api/migration/source-session/query/extra', '/api/migration/source-session/../rpc']) assert.equal(gate.isMobileApiPath(path), false);
  assert.equal(gate.isMobileApiPath('/api/servers/local-1/project-pins'), false);
});
test('migration CORS admits only configured origins and never grants credentials or a wildcard', () => {
  const gate = cors(), headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value), writeHead: status => { response.status = status; }, end() {} };
  assert.deepEqual(gate.applyMobileCors({ headers: { origin }, method: 'OPTIONS' }, response, '/api/migration/source-session/query'), { handled: true, allowed: true });
  assert.equal(response.status, 204); assert.equal(headers.get('access-control-allow-origin'), origin);
  assert.equal(headers.has('access-control-allow-credentials'), false);
  assert.equal(headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  headers.clear();
  assert.deepEqual(gate.applyMobileCors({ headers: { origin: 'https://peer.invalid' }, method: 'POST' }, response, '/api/migration/source-transfer/adoption-prepare'), { handled: false, allowed: false });
  assert.equal(headers.size, 0);
  gate.applyMobileCors({ headers: { origin }, method: 'POST' }, response, '/api/rpc'); assert.equal(headers.size, 0);
});
