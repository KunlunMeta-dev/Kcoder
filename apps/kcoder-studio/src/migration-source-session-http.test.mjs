import test from 'node:test';
import assert from 'node:assert/strict';
import { createMigrationSourceSessionHttp } from './migration-source-session-http.js';

function fixture() {
  const calls = [];
  const options = {
    owner: { open: async () => {}, read: () => ({ status: 'ready' }) },
    requireSameOriginMutation: () => true,
    requestBody: async (_request, limit) => { calls.push(['body', limit]); return JSON.stringify({sessionId:'22222222-2222-4222-8222-222222222222',purpose:'source',targetId:'local'}); },
    jsonResponse: (_response, status, body) => calls.push(['response', status, body]),
    resolveSelection: ({ selection }) => ({ target: { id: selection.targetId }, captureCurrent: () => ({}), workspacePath: undefined }),
  };
  const request = { method: 'POST' };
  return { calls, options, args: { pathname: '/api/migration/source-session/open', request, response: {}, authSession: {} } };
}
test('authentication, verb and Origin gates run before reading or spawning', async () => {
  for (const variant of ['authentication', 'verb', 'origin']) {
    const f = fixture();
    if (variant === 'authentication') f.args.authSession = null;
    if (variant === 'verb') f.args.request.method = 'GET';
    if (variant === 'origin') f.options.requireSameOriginMutation = () => false;
    assert.equal(await createMigrationSourceSessionHttp(f.options)(f.args), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1], {authentication:401,verb:405,origin:403}[variant]);
  }
});
test('body is bounded and successful observation is returned', async () => {
  const f = fixture();
  await createMigrationSourceSessionHttp(f.options)(f.args);
  assert.deepEqual(f.calls, [['body',65536],['response',200,{status:'ready'}]]);
});
test('arbitrary backend error text is never reflected', async () => {
  const f = fixture();
  f.options.resolveSelection = () => { throw new Error('secret/path/token'); };
  await createMigrationSourceSessionHttp(f.options)(f.args);
  assert.deepEqual(f.calls.at(-1), ['response',409,{error:'source_transfer_outcome_unknown'}]);
});
test('unrelated paths are not captured', async () => {
  const f = fixture(); f.args.pathname = '/api/servers';
  assert.equal(await createMigrationSourceSessionHttp(f.options)(f.args), false);
  assert.equal(f.calls.length, 0);
});
