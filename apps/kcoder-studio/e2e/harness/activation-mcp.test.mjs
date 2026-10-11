import assert from 'node:assert/strict';
import test from 'node:test';
import { startActivationMcp } from './activation-mcp.mjs';

test('activation MCP peers register owned cleanup and preserve factual failures', async () => {
  const cleanups = [];
  const ports = [];
  const context = { addCleanup: (label, action) => cleanups.push({ label, action }), registerPort: (label, port) => ports.push({ label, port }) };
  const root = await startActivationMcp(context);
  try {
    assert.equal(cleanups.length, 1);
    assert.equal(ports.length, 1);
    const send = path => fetch(`${root}/${path}`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}) });
    assert.equal((await send('unauthorized')).status, 401);
    assert.equal((await (await send('protocol')).json()).error.code, -32602);
    assert.deepEqual((await (await send('zero')).json()).result.tools, []);
    await assert.rejects(send('disconnect'));
    await assert.rejects(fetch(`${root}/timeout`, {method:'POST', signal: AbortSignal.timeout(25)}));
  } finally { await cleanups[0].action(); }
  await assert.rejects(fetch(`${root}/zero`));
});
