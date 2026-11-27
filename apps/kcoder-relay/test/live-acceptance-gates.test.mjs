import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRelayCleanup } from './caddy-adapter.live.mjs';
import { runAcceptance, SNAPSHOT_PY } from './stun-host.live.mjs';

const domain = 'relay.example.test';
const cleanedCaddy = () => ({ apps: {
  http: { servers: { shared: { routes: [{ match: [{ host: ['added.example.test'] }],
    handle: [{ handler: 'static_response', body: 'preserved' }] }] } } },
  tls: { automation: { policies: [{ subjects: ['added.example.test'] }] } },
} });

test('Caddy cleanup accepts preserved unrelated routes and ordinary TLS policies', () => {
  assertRelayCleanup(cleanedCaddy(), { removeMainFile: false }, domain, 'owned-cleanup');
});

test('Caddy cleanup rejects a remaining on-demand policy after its global ask and routes are gone', () => {
  const config = cleanedCaddy();
  config.apps.tls.automation.policies.push({ subjects: [`*.${domain}`], on_demand: true });
  assert.throws(() => assertRelayCleanup(config, { removeMainFile: false }, domain, 'owned-cleanup'),
    /on-demand TLS policy remains/);
});

test('Caddy cleanup rejects a leftover wildcard route or destructive main-file plan', () => {
  const config = cleanedCaddy();
  config.apps.http.servers.shared.routes.push({ match: [{ host: [`*.${domain}`] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:18451' }] }] });
  assert.throws(() => assertRelayCleanup(config, { removeMainFile: false }, domain, 'owned-cleanup'),
    /Relay route remains/);
  assert.throws(() => assertRelayCleanup(cleanedCaddy(), { removeMainFile: true }, domain, 'owned-cleanup'),
    /preserve the shared Caddyfile/);
});

const options = { host: 'owned-stun-fixture', port: 18462, namespace: 'abcdef123456' };
const goodBinding = { state: 'success', cookieValidated: true, transactionIdValidated: true,
  xorMappedAddressValidated: true, addressFamily: 'ipv4' };
const goodProbe = () => ({ bindingBefore: { ...goodBinding }, bindingAfter: { ...goodBinding },
  turnAllocate: { state: 'ignored', success: false } });

function isolatedStunServices(afterUpgrade = goodProbe) {
  const calls = [];
  let installed = false, upgraded = false, probes = 0;
  const snapshot = { coturnPackage: { dpkg: true }, coturnPackageVersion: { dpkg: 'owned-version' },
    units: { 'coturn.service': { MainPID: 'owned-production-pid' } }, defaultCoturnUnit: {} };
  const services = {
    remotePython(host, program, args = []) {
      assert.equal(host, options.host);
      if (program === SNAPSHOT_PY) return structuredClone(snapshot);
      if (args.length === 2) return { absent: true, portAvailable: true };
      if (args.length === 1) return { unit: true, config: true, receipt: true };
      return { nodeVersion: 'owned-node-version' };
    },
    createRemoteStage(host, stagePath, payload) {
      assert.equal(host, options.host);
      assert.equal(stagePath, `/var/tmp/kcoder-stun-test-${options.namespace}`);
      return { root: {}, deploy: {}, files: Object.fromEntries(Object.entries(payload.hashes).map(([path, sha256], index) =>
        [path, { sha256, uid: 0, mode: '0600', links: 1, device: 1, inode: index + 1 }])) };
    },
    lifecycle(host, _stagePath, action, namespace, port) {
      assert.equal(host, options.host);
      assert.equal(namespace, options.namespace);
      calls.push(action);
      if (action === 'install') installed = true;
      if (action === 'upgrade') upgraded = true;
      if (action === 'cleanup') installed = false;
      return { state: installed ? 'active' : 'absent', receiptState: installed ? 'active' : 'none',
        unit: `kcoder-stun-test-${namespace}.service`, config: `/etc/coturn/kcoder-stun-test-${namespace}.conf`,
        packageManager: 'test', packageInstalledByKcoder: false, port };
    },
    readUnitPid() { return upgraded ? '202' : '101'; },
    probeUdp(host, port) {
      assert.deepEqual([host, port], [options.host, options.port]);
      calls.push('udp-probe');
      probes++;
      return upgraded ? afterUpgrade() : goodProbe();
    },
    cleanupRemoteStage() { calls.push('stage-cleanup'); return { removed: true }; },
    remoteStageAbsent() { return true; },
  };
  return { services, calls, probeCount: () => probes };
}

test('STUN acceptance validates UDP before and after upgrade before it can pass', () => {
  const fixture = isolatedStunServices();
  const report = runAcceptance(options, fixture.services);
  assert.equal(report.state, 'passed');
  assert.equal(fixture.probeCount(), 2);
  assert.deepEqual(fixture.calls, ['status', 'install', 'udp-probe', 'status', 'upgrade', 'udp-probe',
    'status', 'cleanup', 'stage-cleanup']);
  assert.deepEqual(report.stages.upgradeUdpProbe, goodProbe());
  assert.equal(report.cleanupConfirmed, true);
});

for (const fault of ['binding', 'turn-allocation']) {
  test(`STUN acceptance fails on ${fault} after upgrade and still confirms its owned cleanup`, () => {
    const fixture = isolatedStunServices(() => {
      const probe = goodProbe();
      if (fault === 'binding') probe.bindingAfter.transactionIdValidated = false;
      else probe.turnAllocate = { state: 'success', success: true };
      return probe;
    });
    const report = runAcceptance(options, fixture.services);
    assert.equal(report.state, 'failed');
    assert.equal(report.error.phase, 'udp-probe-after-upgrade');
    assert.equal(fixture.probeCount(), 2);
    assert.equal(report.cleanupConfirmed, true);
    assert.deepEqual(fixture.calls.slice(-2), ['cleanup', 'stage-cleanup']);
    assert.equal(report.stages.statusAfterUpgrade, undefined);
    assert.equal(report.productionFingerprintEqual, true);
  });
}
