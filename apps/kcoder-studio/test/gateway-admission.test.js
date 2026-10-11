import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayAdmission } from '../src/gateway-admission.js';

test('anonymous host identity is independent of listening and public proxy ports', () => {
  let port = 4173;
  const admission = createGatewayAdmission({ authRequired: false, publicOrigins: new Set(['https://studio.example:8443']), listeningPort: () => port });
  for (const host of ['localhost:4173', '127.0.0.1:4173', '[::1]:4173', 'studio.example:8443']) {
    assert.equal(admission.isAllowedAuthority(host), true, host);
  }
  for (const host of ['other.example:4173', 'other.example:8443', 'localhost:8443', 'studio.example:4173', 'user@localhost:4173', 'localhost:4173/path', 'localhost:4173/', 'localhost:4173?', 'localhost:4173#', 'localhost:4173\\evil', 'localhost:4173#fragment', '', undefined]) {
    assert.equal(admission.isAllowedAuthority(host), false, host);
  }
  port = 1234;
  assert.equal(admission.isAllowedAuthority('localhost:4173'), false);
  assert.equal(admission.isAllowedAuthority('localhost:1234'), true);
});

test('origin validation rejects credentials and URL suffixes and preserves authenticated hosts', () => {
  const admission = createGatewayAdmission({ authRequired: true, publicOrigins: new Set(['https://studio.example']), listeningPort: () => 4173 });
  assert.equal(admission.isAllowedOrigin('http://remote.example:4173', 'remote.example:4173'), true);
  assert.equal(admission.isAllowedOrigin('https://studio.example', 'studio.example'), true);
  for (const origin of ['http://studio.example', 'http://user@remote.example:4173', 'http://remote.example:4173/path', 'http://remote.example:4173/', 'http://remote.example:4173?', 'http://remote.example:4173#', 'http://remote.example:4173?query', 'http://remote.example:4173#fragment', 'null', 'ftp://remote.example:4173']) {
    assert.equal(admission.isAllowedOrigin(origin, 'remote.example:4173'), false, origin);
  }
});
