import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { isAbsolute, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { runE2E, repoRoot, waitFor } from '../harness/run-context.mjs';
import { prepareWindowsManagedPacCertificates } from '../harness/windows-managed-pac-certificates.mjs';
import { startWindowsManagedPacFixture, windowsManagedPacPayload, WINDOWS_MANAGED_PAC_HOST } from '../harness/windows-managed-pac-fixture.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--runtime' && isAbsolute(args[1]), 'Supply one explicit absolute sealed --runtime');
const runtime = args[1];
await runE2E(import.meta.url, {
  testId: 'whole-sealed-python-bing-network-curl-owned-proxy-tls', tier: 'full-integration',
  modelPolicy: 'Actual sealed launcher and existing Bing/Network/Curl to an owned Node TLS origin through a fake parent broker. Real system DNS, zero public web, paid models, Windows or WinHTTP claim.',
  retainSuccessEvidence: true, budgets: { sourceQueries: 1, modelCalls: 0, wallClockMs: 90000 },
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(90000)]);
  for (const name of ['launch.py', 'egress.py']) assert.deepEqual(await readFile(resolve(runtime, name)), await readFile(resolve(repoRoot, 'scripts/searxng', name)), 'The immutable runtime must use the exact current launcher/egress recipe');
  const prepared = await prepareWindowsManagedPacCertificates(context), payload = windowsManagedPacPayload(prepared.fixtureId);
  const addresses = [...new Set((await lookup(WINDOWS_MANAGED_PAC_HOST, { all: true, verbatim: true })).map(item => item.address))];
  const owned = await startWindowsManagedPacFixture({ fixtureId: prepared.fixtureId, caPem: await readFile(prepared.caPath), certificatePem: await readFile(prepared.certificatePath), privateKeyPem: await readFile(prepared.keyPath), allowedConnectAddresses: addresses }, context);
  assert.equal(owned.fixture.nativeQuery, payload.nativeQuery);
  const input = await context.writeStateJson('python-chain-input.json', owned.fixture);
  const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime-manifest.json'), 'utf8'));
  const temporary = context.pathInState('python-temp'); await mkdir(temporary, { mode: 0o700 });
  context.registerSecret('a'.repeat(64)); context.registerSecret('owned-token');
  let receipt;
  try {
    const child = context.spawnOwned('whole-controlled-python-chain', resolve(runtime, manifest.python), ['-I', '-B', resolve(repoRoot, 'scripts/searxng/managed_pac_python_chain.py'), '--runtime', runtime, '--input', input], {
      env: context.isolatedEnvironment({ SSL_CERT_FILE: prepared.caPath, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '', no_proxy: '' }),
    });
    let output = ''; child.stdout.on('data', bytes => { output += bytes.toString(); });
    await waitFor(() => child.exitCode !== null ? { code: child.exitCode } : null, 65000, 'whole sealed Python chain and original EOF', 50, context.abortSignal);
    const line = output.trim().split(/\r?\n/).findLast(value => value.startsWith('{'));
    receipt = line ? JSON.parse(line) : { wrapperSucceeded: false, errorType: 'MissingSafeReceipt' };
    await context.writeArtifactJson('whole-python-chain.json', { receipt, fixture: owned.fixture, observations: owned.stats(), nodeDnsCaptureCalls: 1, systemDnsAllowed: true, pythonDnsCalls: 'not independently counted' });
    assert.equal(child.exitCode, 0, 'Inspect the retained receipt and source phases; no fixture or production error may be hidden');
    assert.equal(receipt.wrapperSucceeded, true); assert.equal(receipt.ownerEofObserved, true); assert.equal(receipt.sourceCount, 3);
    const stats = owned.stats(); assert.equal(stats.originRequests, 1); assert.ok(stats.connectAccepted >= 1); assert.equal(stats.connectDenied, 0); assert.ok(stats.tlsAccepted >= 1); assert.equal(stats.tlsRejected, 0); assert.equal(stats.originDenied, 0); assert.equal(stats.externalConnections, 0);
    assert.ok(receipt.brokerEvents.some(event => event.op === 'redeem')); assert.ok(receipt.brokerEvents.filter(event => event.op === 'resolve').every(event => event.host === WINDOWS_MANAGED_PAC_HOST && event.markerMatched));
    return { sourceCount: 3, actualSealedBingAndCurl: true, originalOwnerEof: true, publicWebRequests: 0, paidModelCalls: 0, windowsClaim: false };
  } finally {
    await context.writeArtifactJson('fixture-stopped.json', await owned.stop());
  }
});
