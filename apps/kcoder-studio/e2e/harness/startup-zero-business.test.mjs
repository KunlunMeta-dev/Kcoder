import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { gatewayStartupPhases, ownedGatewayProcesses, startStartupBoundary, staticSearchComponents } from './startup-zero-business.mjs';

test('startup phases retain only closed timing facts and discard unrelated or invalid log records', () => {
  const lines = [
    'raw-token-must-not-survive', 'null', '{}', '{broken',
    { event: 'gateway-startup', phase: 'module_imports', status: 'completed', elapsedMs: 25, token: 'private' },
    { event: 'gateway-startup', phase: 'office_resources', status: 'started', elapsedMs: 0 },
    { event: 'gateway-startup', phase: 'office_resources', status: 'failed', elapsedMs: 8 },
    { event: 'other', phase: 'module_imports', status: 'completed', elapsedMs: 1 },
    { event: 'gateway-startup', phase: 'private', status: 'completed', elapsedMs: 1 },
    { event: 'gateway-startup', phase: 'module_imports', status: 'private', elapsedMs: 1 },
    ...[-1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map(elapsedMs => ({ event: 'gateway-startup', phase: 'component_image', status: 'completed', elapsedMs })),
  ];
  assert.deepEqual(gatewayStartupPhases(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')), [
    { phase: 'module_imports', status: 'completed', elapsedMs: 25 },
    { phase: 'office_resources', status: 'started', elapsedMs: 0 },
    { phase: 'office_resources', status: 'failed', elapsedMs: 8 },
  ]);
});

test('Linux startup snapshot includes its live owner and does not adopt an unrelated process tree', { skip: process.platform !== 'linux' }, async () => {
  const snapshots = await ownedGatewayProcesses(process.pid);
  const own = snapshots.find(row => row.pid === process.pid);
  assert.ok(own, 'The snapshot must include its live owner');
  assert.ok(own.costs, 'The current Linux process must expose its own counters');
  for (const value of Object.values(own.costs)) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.deepEqual(await ownedGatewayProcesses(2147483647), []);
});

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
