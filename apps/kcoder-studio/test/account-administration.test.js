import test from 'node:test';
import assert from 'node:assert/strict';
import { administerAccount } from '../src/account-administration.js';

const authentication = { username: 'operator', password: 'synthetic-admin-password' };
function spec(response, expectedOperation = 'list') {
  return { command: process.execPath, args: ['--input-type=module', '-e', `
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const [login, operation] = input.trim().split('\\n').map(JSON.parse);
    if (login.mode !== 'admin' || operation.operation !== ${JSON.stringify(expectedOperation)}) process.exit(2);
    process.stdout.write(JSON.stringify(${JSON.stringify(response)}));
  `] };
}

test('admin control accepts authenticated admin response over a separate process', async () => {
  const result = await administerAccount(spec({ protocol: 'kcoder-account-v1', authenticated: true,
    username: 'operator', role: 'admin', result: [{ username: 'alice' }] }), process.env, authentication, { operation: 'list' });
  assert.deepEqual(result, [{ username: 'alice' }]);
});

test('ordinary audit control accepts only the separately authorized audit operation', async () => {
  const response = { protocol: 'kcoder-account-v1', authenticated: true, username: 'operator', role: 'user', result: { events: [] } };
  const result = await administerAccount(spec(response, 'organization.export'), process.env, authentication,
    { operation: 'organization.export', resourceId: 'audit:organization' });
  assert.deepEqual(result, { events: [] });
  await assert.rejects(administerAccount(spec(response, 'organization.inspect'), process.env, authentication,
    { operation: 'organization.inspect' }));
});

test('admin control rejects ordinary or mismatched account responses', async () => {
  for (const overrides of [{ role: 'user' }, { username: 'alice' }, { authenticated: false }]) {
    await assert.rejects(administerAccount(spec({ protocol: 'kcoder-account-v1', authenticated: true,
      username: 'operator', role: 'admin', result: [], ...overrides }), process.env, authentication, { operation: 'list' }));
  }
});
