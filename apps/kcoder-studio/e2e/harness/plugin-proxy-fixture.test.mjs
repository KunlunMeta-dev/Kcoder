import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { RunContext } from './run-context.mjs';
import { startPluginProxyFixture } from './plugin-proxy-fixture.mjs';

test('owned false-positive proxy accepts CONNECT, sends no TLS, and closes on cleanup', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'proxy-fixture-cleanup' });
  let fixture;
  try {
    fixture = await startPluginProxyFixture(context, { origin: 'https://127.0.0.1:1/' });
    const reply = await new Promise((done, reject) => {
      const socket = connect(fixture.badPort, '127.0.0.1', () => socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n'));
      socket.once('error', reject); let value=''; socket.on('data', chunk => value += chunk); socket.once('end', () => done(value));
    });
    assert.match(reply, /200 Connection Established/); assert.equal(fixture.counts.bad, 1);
  } finally { await context.finish('passed', { ok: true }); }
  for (const port of [fixture.badPort, fixture.goodPort]) {
    await new Promise((done, reject) => { const socket=connect(port,'127.0.0.1'); socket.once('connect',()=>{socket.destroy();reject(new Error('fixture port survived cleanup'))}); socket.once('error',done); });
  }
});
