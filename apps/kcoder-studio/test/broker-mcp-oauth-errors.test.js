import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerMcpOAuth } from '../src/broker-mcp-oauth.js';

test('OAuth failure notifications expose stable categories, never upstream error details', () => {
  for (const [message, expected] of [
    ['OAuth credential storage failed: /private/home/token-secret.json', 'credential_storage_failed'],
    ['OAuth token endpoint HTTP 503: secret=do-not-forward', 'token_exchange_failed'],
    ['unexpected failure Bearer private-credential', 'authorization_failed'],
  ]) {
    const messages = [];
    const browser = [];
    const client = {};
    const broker = new BrokerMcpOAuth({ attached: () => true, notify: (_, value) => messages.push(value) });
    broker.tickets.add({ flowId: 'owned-flow', receiver: { completeAuthorization: value => browser.push(value) } });
    assert.equal(broker.response({ client, oauthCompletion: 'owned-flow' }, { error: { message } }), true);
    assert.deepEqual(messages, [{ flowId: 'owned-flow', status: 'failed', message: expected }]);
    assert.equal(browser[0].reason, expected);
    assert.ok(!JSON.stringify(messages).includes('private'));
    assert.ok(!JSON.stringify(browser).includes('private'));
  }
});
