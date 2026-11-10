import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessionCookies } from '../src/browser-session-cookie.js';

test('public HTTPS sessions reject parent-domain legacy cookies and keep __Host scope on issue and expiry', () => {
  const policy = createBrowserSessionCookies({ publicOrigins: new Set(['https://gateway.example']) });
  const request = { headers: { host: 'gateway.example', cookie: 'kcoder_studio_session=parent-forgery' } };
  assert.equal(policy.read(request), null);
  const issued = policy.header(request, 'private-session', 100, '/g/a/');
  assert.match(issued, /^__Host-kcoder_studio_session=private-session;/);
  assert.ok(issued.includes('Path=/;'));
  assert.ok(issued.endsWith('; Secure'));
  assert.ok(!issued.includes('Domain='));
  request.headers.cookie += '; __Host-kcoder_studio_session=real-session';
  assert.equal(policy.read(request), 'real-session');
  request.headers.cookie += '; __Host-kcoder_studio_session=ambiguous';
  assert.equal(policy.read(request), null);
  assert.ok(policy.header(request, '', 0).includes('Max-Age=0; Secure'));
  const local = { headers: { host: '127.0.0.1:4186', cookie: 'kcoder_studio_session=local-session' } };
  assert.equal(policy.read(local), 'local-session');
  assert.match(policy.header(local, 'local-session', 100), /^kcoder_studio_session=/);
});
