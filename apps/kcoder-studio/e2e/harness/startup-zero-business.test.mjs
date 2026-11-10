import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { startStartupBoundary, staticSearchComponents } from './startup-zero-business.mjs';

test('startup boundary serves only model metadata and refuses inference or outbound CONNECT', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'startup-zero-business-boundary', tier: 'harness-unit', modelPolicy: 'Owned loopback denial and static files only; no model/native acceptance claim' });
  let failure;
  try {
    const fixture = await startStartupBoundary(context);
    assert.equal((await fetch(fixture.modelUrl + '/models')).status, 200);
    assert.equal((await fetch(fixture.modelUrl + '/chat/completions', { method: 'POST', body: '{}' })).status, 503);
    const proxy = new URL(fixture.proxyUrl);
    const refused = await new Promise((resolve, reject) => {
      const call = request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: '203.0.113.1:443' });
      call.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); }); call.once('error', reject); call.end();
    });
    assert.equal(refused, 403);
    assert.deepEqual(fixture.counters, { modelGenerations: 1, modelMetadataRequests: 1, searchAttempts: 0, pageAttempts: 0, forbiddenConnects: 1 });
    const binary = context.pathInState('package/kcoder'), component = context.pathInState('package/lib/kcoder/searxng');
    await mkdir(component, { recursive: true }); await writeFile(component + '/runtime-manifest.json', '{}');
    const snapshot = await staticSearchComponents(binary); assert.equal(snapshot.filter(row => row.manifestPresent).length, 1);
    assert.ok(snapshot.every(row => row.scope.includes('no service')));
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { noSourceForwarding: true }, failure); }
});
