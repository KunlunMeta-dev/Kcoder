import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { repoRoot, runE2E, requireExecutable } from '../../harness/run-context.mjs';
const exec = promisify(execFile);

await runE2E(import.meta.url, {
  testId: 'account-workers-isolate-files-and-revocation-in-container', tier: 'full-integration',
  modelPolicy: 'actual account dispatcher and CLI; synthetic identities only inside disposable container',
}, async context => {
  const docker = await requireExecutable('/usr/bin/docker', 'Docker daemon and client');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const fingerprint = createHash('sha256');
  for await (const chunk of createReadStream(binary)) fingerprint.update(chunk);
  await context.writeArtifactJson('runtime-binary.json', { path: binary, sha256: fingerprint.digest('hex') });
  await exec(docker, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });
  const buildNetwork = process.env.KCODER_E2E_DOCKER_BUILD_NETWORK || 'default';
  assert.ok(['default', 'none', 'host'].includes(buildNetwork), 'invalid Docker build network');
  const suffix = randomUUID();
  const image = `kcoder-p2-account-e2e:${suffix}`;
  const container = `kcoder-p2-account-e2e-${suffix}`;
  const wait = child => new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveDone() : reject(new Error(`owned container command failed (${code ?? signal}); see process log`)));
  });
  for (const secret of ['synthetic-isolation-password', 'synthetic-rotated-password', 'synthetic-account-admin-password', 'synthetic-alice-model-key', 'synthetic-bob-model-key', 'synthetic-administrator-model-key']) context.registerSecret(secret);
  context.addCleanup('remove owned account image', async () => {
    try { await exec(docker, ['image', 'rm', image], { timeout: 30000 }); }
    catch (error) { if (!String(error.stderr).includes('No such image')) throw error; }
  });
  await wait(context.spawnOwned('account-image-build', docker, ['build', '--network', buildNetwork, '-t', image,
    resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/accounts')]));
  context.addCleanup('remove owned account container', async () => {
    try { await exec(docker, ['rm', '-f', container], { timeout: 10000 }); }
    catch (error) { if (!String(error.stderr).includes('No such container')) throw error; }
  });
  await wait(context.spawnOwned('account-runtime-isolation', docker, ['run', '--rm', '--name', container,
    '--network', 'none', '--mount', `type=bind,src=${repoRoot},dst=/repo,readonly`,
    '--mount', `type=bind,src=${binary},dst=/usr/local/bin/kcoder,readonly`,
    '--env', 'KCODER_TEST_SYSTEM_USERS=1', '--entrypoint', '/usr/bin/python3', image,
    '/repo/scripts/install/tests/test_studio_account_runtime.py']));
  await wait(context.spawnOwned('account-ssh-matrix', docker, ['run', '--rm', '--name', container,
    '--network', 'none', '--mount', `type=bind,src=${repoRoot},dst=/repo,readonly`,
    '--mount', `type=bind,src=${binary},dst=/usr/local/bin/kcoder,readonly`,
    '--env', 'KCODER_TEST_SYSTEM_USERS=1', '--entrypoint', '/usr/bin/python3', image,
    '/repo/apps/kcoder-studio/e2e/fixtures/accounts/account_matrix.py']));
  return { privateModelCatalogAndCredentials: true, emptyAccountNoInheritedCredential: true, emptyAccountCreatedAfterAdministratorKey: true, emptyAccountHttpRequests: 0, actualWorkerUids: true, sameSshKeyAndRoot: true, identityMigrationWithoutContext: true,
    passwordDisableRevokeIsolated: true, repeatedAndConflictingImportAtomic: true, ordinarySshPreserved: true, hostAccountsModified: false, network: 'none' };
});
