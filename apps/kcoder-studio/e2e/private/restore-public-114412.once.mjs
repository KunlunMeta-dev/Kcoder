import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repoRoot, runE2E } from '../harness/run-context.mjs';
import { restoreRoutesOnlySidecarOnce } from '../harness/single-ssh-sidecar-restore.mjs';

const parentRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-114412.125Z`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await runE2E(import.meta.url, {
  testId: 'restore-public-114412-exact-owned-sidecar', tier: 'manual-live',
  retainSuccessLogs: true, cleanupTimeoutMs: 120_000,
  modelPolicy: 'Exact owned test443 recovery only; production8451 is read-only; no Browser or Provider',
}, async context => {
  assert.equal(process.version, 'v22.17.0');
  const parent = JSON.parse(await readFile(`${parentRoot}/manifest.json`, 'utf8'));
  assert.equal(parent.status, 'failed');
  const candidate = JSON.parse(await readFile(`${parentRoot}/artifacts/routes-only-sidecar-candidate.json`, 'utf8'));
  const suffix = sha(parent.seed).slice(0, 24);
  assert.equal(suffix, 'd97b728a3676782d551eb3cd');
  assert.equal(candidate.marker, `kc_route_${suffix}`);
  assert.equal(candidate.candidatePid, 284838);
  assert.equal(candidate.candidateConfigSha256, '6670fa0f1a3b5298e473226d3584390612b816f636170bb383459f7c68470789');
  const helper = `${repoRoot}/apps/kcoder-studio/e2e/harness/single-ssh-sidecar-restore.mjs`;
  assert.equal(sha(await readFile(helper)), '9783bb8bba15ecb7adfd7f2a665e6c2e82a64b96cf6ef2766ff01cfc841c1b06');
  const stop = JSON.parse(await readFile(`${repoRoot}/target/private-phone-ux-validation/public-114412-recovery-root-20261009/relay-stop.json`, 'utf8'));
  assert.equal(stop.relayPid, 284886);
  assert.equal(stop.identityVerified, true);
  assert.equal(stop.exited, true);
  assert.equal(stop.port32552Free, true);
  const original = {
    configPath: '/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile',
    configSha256: '520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c', pid: 281568,
  };
  const transaction = {
    root: `/tmp/kc-phone-ux-rust-baseline-${suffix}`, marker: candidate.marker,
    configPath: `/tmp/kc-phone-ux-rust-baseline-${suffix}/isolated-443-front.Caddyfile`,
    candidatePid: 284838, candidateSha256: candidate.candidateConfigSha256,
    candidateStartRequested: true, original, staticRootSha256: '8f414deda3c4aa5807078dab4ee6520b4cd96298e34dfc40368e06ff7371a92e',
  };
  const before = {
    forwardFree: true, productionOwners: [{ pid: 200738, exe: '/usr/bin/caddy', euid: 996,
      argvConfigMatch: true, argvSha256: '626a004e20430eca69818647d5102f62bf953632ce3e06e0d4016ac2b32099fd' }],
    productionListenerSha256: 'dc50003e06a3fb199d513a16b89f4b2e8c8f5604463aa27214dc93d8402a1f19',
    sidecar: { pid: original.pid, configSha256: original.configSha256 },
  };
  await context.writeArtifactJson('restore-input.json', { parentRoot, transaction, before,
    relayStop: stop, boundary: 'Helper revalidates production owner/config/listener, free32552, static tree and exact owned candidate before mutation' });
  const result = await restoreRoutesOnlySidecarOnce(context, transaction, before, {
    repoRoot, sshTarget: 'aliyun', sshOptions: ['-F', '/home/hyf/.ssh/config', '-o', 'UserKnownHostsFile=/home/hyf/.ssh/known_hosts',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15'],
    productionConfigPath: '/etc/caddy/Caddyfile',
    productionConfigSha256: '05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511',
    expectedStaticRoot: '/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root', expectedStaticFiles: 37,
  });
  return { restoredSidecarPid: result.restoredSidecarPid, rootRemoval: result.rootRemoval,
    staticRoot: result.staticRoot, production8451Touched: false };
});
