import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { selectRelayHttpDiagnosticVersion } from './relay-http-phase-version.mjs';
import { sha256 } from './relay-http-phase-observation.mjs';
import { runE2E } from './run-context.mjs';
import { gatewayOriginLabel } from '../../../kcoder-relay/src/gateway-origin.mjs';

const serverUrl = new URL('../../../kcoder-relay/src/server.mjs', import.meta.url);
const requireRelay = createRequire(serverUrl);

test('v1 and v2 bind distinct reviewed source, helper and overlay bytes', async () => {
  const legacy = gunzipSync(await readFile(new URL('./fixtures/relay-http-v1-server.mjs.gz', import.meta.url))).toString('utf8');
  const current = await readFile(serverUrl, 'utf8');
  for (const [source, expected] of [[legacy, 'relay-public-http-phase-v1'], [current, 'relay-public-http-phase-v2']]) {
    const version = selectRelayHttpDiagnosticVersion(sha256(source));
    const overlay = version.apply(source);
    assert.equal(overlay.patchVersion, expected);
    assert.equal(overlay.sourceSha256, version.overlaySha256);
    assert.equal(sha256(await readFile(new URL(version.helperFilename, import.meta.url))), version.helperSha256);
    assert.throws(() => version.apply(source + '\n'), /source SHA-256 mismatch/);
    const collector = version.module.createRelayHttpDiagnosticCollector({ maxEvents: 1, maxBytes: 4096 });
    assert.equal(collector.push({ event: 'public-http-entry', body: 'PRIVATE_DIAGNOSTIC_CANARY' }), false);
    assert.equal(collector.push({ event: 'public-http-entry', method: 'POST' }), true);
    assert.equal(collector.push({ event: 'public-response-finished', statusCode: 200 }), false);
    assert.equal(collector.snapshot().droppedCount, 1);
    assert.equal(JSON.stringify(collector.snapshot()).includes('PRIVATE_DIAGNOSTIC_CANARY'), false);
  }
  assert.throws(() => selectRelayHttpDiagnosticVersion('0'.repeat(64)), /not reviewed/);
  assert.equal(selectRelayHttpDiagnosticVersion(sha256(legacy)).historicalExpectedHelperSha256,
    '7a0bd48c2257691d4fac23d787a1fa4e97c3029e8a0c232b27423d88a50f5628');
});

test('v2 executes the actual reviewed Relay HTTP path with bounded private diagnostics', async () => {
  await runE2E(import.meta.url, { tier: 'model-independent',
    modelPolicy: 'owned loopback HTTP and source overlay only; no model, account, SSH or public Relay' }, async context => {
    const source = await readFile(serverUrl, 'utf8');
    const version = selectRelayHttpDiagnosticVersion(sha256(source));
    const overlay = version.apply(source);
    // Resolve imports exactly as the original package would, without copying a live runtime.
    const executable = overlay.source.replace(/from (['"])([^'"]+)\1/g, (text, quote, specifier) => {
      if (specifier.startsWith('node:')) return text;
      const resolved = specifier.startsWith('.') ? new URL(specifier, serverUrl).href
        : specifier === 'ws' ? new URL('./wrapper.mjs', pathToFileURL(requireRelay.resolve('ws/package.json'))).href
          : pathToFileURL(requireRelay.resolve(specifier)).href;
      return 'from ' + quote + resolved + quote;
    });
    const { startRelay } = await import('data:text/javascript;base64,' + Buffer.from(executable).toString('base64'));
    const collector = version.module.createRelayHttpDiagnosticCollector({ maxEvents: 32, maxBytes: 8192 });
    const key = Symbol.for('kcoder.e2e.relay-public-http-diagnostic'), previous = globalThis[key];
    globalThis[key] = record => collector.push(record);
    context.addCleanup('remove owned Relay diagnostic observer', () => {
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    });
    const secret = 'owned-inert-relay-secret-0123456789-0123456789'; context.registerSecret(secret);
    const gatewaySecret = 'owned-independent-gateway-0123456789-0123456789'; context.registerSecret(gatewaySecret);
    const relay = await startRelay({ gateways: [{ id: 'owned', secret, gatewaySecret }], sharedHosts: ['relay.test'], controlPort: 0, proxyPort: 0 });
    context.addCleanup('close owned offline Relay', () => relay.close());
    context.registerPort('owned Relay control', relay.controlPort); context.registerPort('owned Relay HTTP', relay.proxyPort);
    const status = await new Promise((resolve, reject) => {
      const call = request({ host: '127.0.0.1', port: relay.proxyPort, path: '/g/owned/api/mobile/session',
        method: 'POST', headers: { host: gatewayOriginLabel('owned') + '.relay.test', 'content-type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      call.setTimeout(3000, () => call.destroy(new Error('Owned HTTP fixture timeout')));
      call.once('error', reject); call.end('{}');
    });
    assert.equal(status, 503);
    const snapshot = collector.snapshot();
    assert.ok(snapshot.events.some(row => row.event === 'public-http-entry'));
    assert.ok(snapshot.events.some(row => row.event === 'gateway-online-check' && row.decision === 'offline'));
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(snapshot.droppedCount, 0);
    assert.equal(sha256(await readFile(serverUrl)), version.baseSha256);
    await context.writeArtifactJson('relay-overlay-identity.json', { baseSha256: overlay.baseSha256,
      overlaySha256: overlay.sourceSha256, helperSha256: version.helperSha256, patchVersion: overlay.patchVersion,
      events: snapshot, originalSourceUnchanged: true, importResolutionOnly: true });
    return { status, diagnostics: true, liveModelCalls: 0, externalMessages: 0 };
  });
});
