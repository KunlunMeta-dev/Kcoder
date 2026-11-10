import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, stat, access, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, join } from 'node:path';
import { runE2E, repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startMigrationNoInferenceFixture, assertNoMigrationInference } from '../../harness/migration-no-inference.mjs';
import { runWindowsNativeLibtest } from '../../harness/windows-native-libtest.mjs';
import { seedCrossHostAdoptionSource } from '../../harness/windows-cross-host-adoption.mjs';
import { seedCrossHostContentSource, verifyCrossHostContentSource } from '../../harness/windows-cross-host-content-fixture.mjs';
import { crossHostPrivateCanaries, seedCrossHostPrivateFields } from '../../harness/windows-cross-host-content-private.mjs';
import { CROSS_HOST_INSTRUCTION_TARGETS } from '../../harness/windows-cross-host-content-packages.mjs';
import { CROSS_HOST_CONTENT_VERSION, validateCrossHostContentEvidence } from '../../harness/windows-cross-host-content-contract.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
assert.equal(process.env.KCODER_E2E_WINDOWS_CROSS_HOST_SOURCE, '1', 'Explicit two-machine test consent required');
await runE2E(import.meta.url, { testId: 'windows-linux-source-transfer-adoption', tier: 'manual-live',
  modelPolicy: 'actual Windows/Linux sources in owned directories; configuration/skill/history/memory/passive definitions/scoped instruction graph/plugin/HPKE private file values receive, explicit adoption/publication/reopen/owned Undo; no model/source program/installer/GUI' }, async context => {
  const checkout = process.env.KCODER_E2E_WINDOWS_CROSS_HOST_CHECKOUT;
  assert.ok(checkout && resolve(checkout) === checkout && await realpath(checkout) === checkout, 'explicit clean frozen checkout required');
  const ownedRelative = relative(resolve(repoRoot, 'target/worktree'), checkout);
  assert.match(ownedRelative, /^\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Gateway sources require a dedicated dated worktree');
  assert.ok(['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY));
  const linuxBinary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'frozen Linux Native');
  const linuxSha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(linuxSha256 ?? '', /^[a-f0-9]{64}$/); assert.equal(sha(await readFile(linuxBinary)), linuxSha256);
  const fixture = context.pathInState('linux'); await mkdir(fixture);
  const workspace = join(fixture, 'workspace'), source = join(fixture, 'source'), profile = join(fixture, 'profile'), home = join(fixture, 'home');
  for (const path of [workspace, source, profile, home]) await mkdir(path);
  const binary = join(fixture, 'kcoder'); await cp(linuxBinary, binary);
  assert.equal(sha(await readFile(binary)), linuxSha256);
  const model = await startMigrationNoInferenceFixture(context);
  const marker = join(fixture, 'source-hook-must-not-run');
  const fixtureRoot = resolve(checkout, 'apps/kcoder-studio/e2e/fixtures/migration');
  const original = await readFile(join(fixtureRoot, 'history-source-compressed.jsonl.zst'));
  const decoded = await readFile(join(fixtureRoot, 'history-source-compressed.jsonl'));
  for (const label of ['windows', 'linux']) for (const value of crossHostPrivateCanaries(label)) context.registerSecret(value);
  const sourceFixture = await seedCrossHostPrivateFields(source, 'linux', await seedCrossHostAdoptionSource(source, 'linux', marker, original, decoded));
  const contentFixture = await seedCrossHostContentSource(source, 'linux', marker);
  for (const scopes of Object.values(CROSS_HOST_INSTRUCTION_TARGETS)) for (const scope of Object.values(scopes)) await mkdir(join(workspace, ...scope.split('/')), { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'trusted-folders.json'), JSON.stringify({ version: 1, trusted: [workspace, ...Object.values(contentFixture.instructionRoots)], never: [] }), { mode: 0o600 });
  const settings = JSON.stringify({ credential_store: 'file', hooks: {}, mcp_servers: [], active_provider: 'fixture', providers: {
    fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', discover_models: false, no_proxy: true, context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 4096 },
  } });
  await writeFile(join(profile, 'settings.json'), settings, { mode: 0o600 });
  const launcher = join(fixture, 'launch'), pids = join(fixture, 'native-pids');
  for (const path of [profile, source, binary, pids]) assert.match(path, /^\/[a-zA-Z0-9_./-]+$/);
  await writeFile(launcher, `#!/bin/sh\nset -eu\nprintf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" >> '${pids}'\nexec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME='${home}' USERPROFILE='${home}' XDG_CONFIG_HOME='${home}/.config' KCODER_CONFIG_DIR='${profile}' CLAUDE_CONFIG_DIR='${source}' CODEX_HOME='${source}/codex' RUST_BACKTRACE=0 '${binary}' "$@"\n`, { mode: 0o700 });
  const nativeCleanupPath = context.pathInArtifacts('linux-native-cleanup.json');
  context.addCleanup('stop only original owned Linux Native children', async () => {
    const entries = (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    for (const entry of entries) {
      const [pid, birth] = entry.split(' '); assert.match(pid, /^\d+$/); assert.match(birth, /^\d+$/);
      const original = async () => {
        try { const content = await readFile(`/proc/${pid}/stat`, 'utf8'); return content.slice(content.lastIndexOf(')') + 2).split(' ')[19] === birth && await readFile(`/proc/${pid}/cmdline`, 'utf8').then(v => v.split('\0')[0] === binary); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
      };
      if (await original()) { process.kill(Number(pid), 'SIGTERM'); await waitFor(async () => !await original(), 5000, 'owned Linux Native exit'); }
    }
    await writeFile(nativeCleanupPath, JSON.stringify({ originalNativeProcessesAbsent: true, observedProcessBirths: entries.length }));
  });
  const ssh = await startSshFixture(context, { listenHost: process.env.KCODER_E2E_WINDOWS_LINUX_ADDRESS });
  const privateKey = await readFile(join(ssh.root, 'client-key'), 'utf8'); context.registerSecret(privateKey);
  const hostKey = (await readFile(join(ssh.root, 'host-key.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  const knownHosts = context.pathInState('cross-host-known-hosts');
  await writeFile(knownHosts, `[${ssh.listenHost}]:${ssh.port} ${hostKey}\n`, { mode: 0o600 });
  const gateway = context.pathInState('gateway-snapshot'); await mkdir(gateway);
  const app = resolve(checkout, 'apps/kcoder-studio');
  await cp(join(app, 'dev-server.mjs'), join(gateway, 'dev-server.mjs'));
  await cp(join(app, 'src'), join(gateway, 'src'), { recursive: true, filter: path => !/(?:\.test\.|\/__tests__\/|\/__fixtures__\/)/.test(path) });
  await cp(join(app, 'shared'), join(gateway, 'shared'), { recursive: true });
  await mkdir(join(gateway, 'fixtures'));
  await writeFile(join(gateway, 'fixtures/history-source-compressed.jsonl.zst'), original);
  await writeFile(join(gateway, 'fixtures/history-source-compressed.jsonl'), decoded);
  await cp(resolve(repoRoot, 'target/packages/kcoder-studio/gateway-dependencies/node_modules'), join(gateway, 'node_modules'), { recursive: true, dereference: true });
  await writeFile(join(gateway, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  const files = [];
  async function inventory(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name); assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) await inventory(file);
      else { assert.ok((await stat(file)).isFile()); const bytes = await readFile(file); files.push({ path: relative(gateway, file).replaceAll('\\', '/'), sha256: sha(bytes), bytes: bytes.length }); }
    }
  }
  await inventory(gateway); files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { files }; await writeFile(join(gateway, 'source-manifest.json'), JSON.stringify(manifest));
  await context.writeArtifactJson('gateway-source-manifest.json', manifest);
  const bundle = context.pathInState('gateway.tar'); await execute('tar', ['-cf', bundle, '-C', gateway, '.']);
  const result = await runWindowsNativeLibtest(context, {
    consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, probeKind: 'cross-host-source',
    target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
    node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
    testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
    expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
    expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true',
    supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
    gatewayBundle: bundle, gatewayBundleSha256: sha(await readFile(bundle)), sshWrapper: process.env.KCODER_E2E_WINDOWS_SSH_WRAPPER_BIN,
    sshWrapperSha256: process.env.KCODER_E2E_WINDOWS_SSH_WRAPPER_SHA256, clientKey: join(ssh.root, 'client-key'), knownHosts,
    crossHost: { host: ssh.listenHost, port: ssh.port, user: ssh.user, command: launcher, workspace, source, profile, sourceFixture,
      contentVersion: CROSS_HOST_CONTENT_VERSION, contentFixture },
  });
  assert.equal(result.details.results.length, 2);
  const contentEvidence = validateCrossHostContentEvidence(result.details);
  for (const item of sourceFixture.files) assert.equal(sha(await readFile(join(source + '-offline', ...item.path.split('/')))), item.sha256);
  const contentIntegrity = await verifyCrossHostContentSource(source + '-offline', contentFixture);
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')), JSON.parse(settings));
  await assert.rejects(access(marker)); const linuxHttpAudit = assertNoMigrationInference(model.requests);
  const nativeIdentity = JSON.parse(await readFile(join(profile, 'migrations/source-transfer/native.json'), 'utf8'));
  assert.match(nativeIdentity.account, /^unix:\d+$/);
  assert.notEqual(sha(nativeIdentity.account), result.details.nativeAccountSha256);
  await context.writeArtifactJson('linux-source-integrity.json', { files: sourceFixture.files, sourceUnchanged: true, targetSettingsRestored: true, sourceHooksExecuted: 0, modelRequests: 0, linuxHttpAudit });
  return { ...result.details, linuxNativeAccountKind: 'unix_euid', linuxNativeAccountSha256: sha(nativeIdentity.account), linuxSourceUnchanged: true,
    linuxNativeUid: Number(nativeIdentity.account.slice('unix:'.length)), dedicatedAccountIsolationClaim: false,
    contentVersion: CROSS_HOST_CONTENT_VERSION, contentEvidence, linuxNativeSha256: linuxSha256, linuxContentIntegrity: contentIntegrity,
    linuxSettingsRestored: true, linuxModelRequests: 0, linuxHttpAudit, realTwoMachines: true, settingsPublished: true, publishedOutputsUndone: true };
});
