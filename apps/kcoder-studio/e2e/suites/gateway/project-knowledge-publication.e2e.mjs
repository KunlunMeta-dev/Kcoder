import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';
import { prepareInstalledDesktop } from '../../harness/installed-desktop-identity.mjs';
import { hashExecutableFile } from '../../harness/owned-executable-provenance.mjs';
import { MARKERS, SOURCE, V1, projectKnowledgeFixture, projectKnowledgeSettings, sha256 } from '../../harness/project-knowledge-fixture.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { secureWindowsKnowledgeBaseline } from '../../harness/windows-project-knowledge-baseline.mjs';

const worker = fileURLToPath(new URL('../../harness/project-knowledge-worker.mjs', import.meta.url));
const quoteSh = path => `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
await runE2E(import.meta.url, {
  testId: 'native-project-knowledge-confirmation-and-next-task', tier: 'full-integration',
  modelPolicy: 'deterministic local provider drives real Engine/Specs tools, JSONL approvals and persisted publication; no model-quality, GUI or paid-provider claim',
  retainSuccessLogs: true, cleanupTimeoutMs: process.platform === 'win32' ? 180000 : 60000,
}, async context => {
  assert.ok(['linux', 'win32'].includes(process.platform), 'UNMET_PREREQUISITE: Linux or Windows Native required');
  const binaryPath = process.env.KCODER_E2E_STATE_NATIVE_BIN || process.env.KCODER_E2E_KCODER_BIN;
  const expectedSha = process.env.KCODER_E2E_STATE_NATIVE_SHA256 || process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.match(expectedSha ?? '', /^[a-f0-9]{64}$/, 'Explicit Native image SHA256 required');
  const binary = await hashExecutableFile(await requireExecutable(binaryPath, 'pinned project knowledge Native'));
  assert.equal(binary.sha256, expectedSha);
  let installed = null;
  if (process.platform === 'win32') {
    installed = await prepareInstalledDesktop(context, { label: 'knowledge-native',
      directory: process.env.KCODER_E2E_PACKAGED_DIR, expected: {
        manifestSha256: process.env.KCODER_E2E_PACKAGED_MANIFEST_SHA256,
        hostSha256: process.env.KCODER_E2E_PACKAGED_HOST_SHA256,
        expectedCommit: process.env.KCODER_RELEASE_EXPECTED_COMMIT,
      } });
    assert.equal((await realpath(installed.nativePath)).toLowerCase(), binary.path.toLowerCase());
    assert.equal(installed.nativeSha256, binary.sha256);
    assert.equal((await realpath(process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN)).toLowerCase(), (await realpath(installed.supervisorPath)).toLowerCase());
    assert.equal((await hashExecutableFile(installed.supervisorPath)).sha256, installed.supervisorSha256);
  }
  const sourcePaths = [fileURLToPath(import.meta.url), worker,
    fileURLToPath(new URL('../../harness/project-knowledge-fixture.mjs', import.meta.url)),
    ...['app-server-stdio.mjs', 'approval-model.mjs', 'run-context.mjs', 'owned-process.mjs', 'installed-desktop-identity.mjs', 'workspace-fixture.mjs']
      .map(name => fileURLToPath(new URL(`../../harness/${name}`, import.meta.url))),
    fileURLToPath(new URL('../../../../../scripts/release/artifact-manifest.mjs', import.meta.url))];
  if (process.platform === 'win32') sourcePaths.push(...['windows-project-knowledge-baseline.mjs', 'windows-project-knowledge-baseline.ps1']
    .map(name => fileURLToPath(new URL(`../../harness/${name}`, import.meta.url))));
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  const postflightPath = context.pathInArtifacts('knowledge-source-postflight.json');
  let extraPins = [];
  context.addCleanup('verify project knowledge sources and Native unchanged', async () => {
    const after = await Promise.all(sources.map(async source => ({ ...source, unchanged: sha256(await readFile(source.path)) === source.sha256 })));
    const nativeUnchanged = (await hashExecutableFile(binary.path)).sha256 === binary.sha256;
    const tools = await Promise.all(extraPins.map(async pin => ({ ...pin, unchanged: (await hashExecutableFile(pin.path)).sha256 === pin.sha256 })));
    await writeFile(postflightPath, JSON.stringify({ sources: after, nativeUnchanged, tools }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assert.ok(after.every(source => source.unchanged) && nativeUnchanged && tools.every(pin => pin.unchanged));
  });
  const gitTemplate = context.pathInState('empty-git-template');
  await mkdir(gitTemplate, { recursive: false, mode: 0o700 });
  const gitEnvironment = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: gitTemplate };
  // This dedicated suite process must be isolated before the existing materializer starts Git.
  Object.assign(process.env, gitEnvironment);
  const { path: workspace, gitHead } = await materializeWorkspace(context, 'git-history', { instanceId: 'project-knowledge' });
  const profile = context.pathInState('profile'), temporary = context.pathInState('tmp');
  for (const path of [resolve(workspace, dirname(SOURCE)), profile, temporary]) await mkdir(path, { recursive: true, mode: 0o700 });
  // Fixture baseline only. All candidate and published updates must pass actual Native tools.
  await writeFile(resolve(workspace, SOURCE), V1, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(workspace, 'interface.json'), '{"version":"one"}\n', { flag: 'wx', mode: 0o600 });
  if (process.platform === 'win32') await secureWindowsKnowledgeBaseline(context);
  const trustedWorkspace = toNamespacedPath(await realpath(workspace));
  await context.writeStateJson('profile/trusted-folders.json', { trusted: [trustedWorkspace], never: [] });
  const precheck = `${quoteSh(process.execPath)} ${quoteSh(worker)} --precheck ${quoteSh(workspace)}`;
  const scenario = projectKnowledgeFixture(precheck, { readPublished: () => readFileSync(resolve(workspace, SOURCE), 'utf8') });
  const model = await startApprovalModelFixture(context, { responseSteps: scenario.responseSteps });
  const settingsPath = await context.writeStateJson('profile/settings.json', projectKnowledgeSettings(model.baseUrl));
  const settingsBefore = await readFile(settingsPath);
  const gitSh = process.platform === 'win32' ? await hashExecutableFile(await requireExecutable(process.env.KCODER_E2E_GIT_SH_BIN, 'fixed Git sh for Specs precheck')) : null;
  if (gitSh) {
    assert.match(process.env.KCODER_E2E_GIT_SH_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(gitSh.sha256, process.env.KCODER_E2E_GIT_SH_SHA256);
  }
  const node = await hashExecutableFile(process.execPath); extraPins = [node, ...(gitSh ? [gitSh] : [])];
  await context.writeArtifactJson('knowledge-native-inputs.json', { platform: process.platform, binary, installed, sources,
    node, gitSh, precheck, workspaceGitHead: gitHead,
    gitIsolation: { scope: 'dedicated suite process before materialization and explicitly inherited by the owned worker/Native', environment: gitEnvironment },
    budgets: { providerRequests: 64, expectedProviderRequests: 46, userTurns: 6, workerMs: 180000 },
    trust: { source: 'owned profile trust store', workspace }, scope: 'real Native/tool/protocol execution; fixed provider, no GUI or model-quality claim' });
  const receiptPath = context.pathInState('native-receipt.json');
  const child = context.spawnOwned('project-knowledge-worker', process.execPath, [worker, binary.path, workspace, receiptPath], {
    cwd: context.stateDir, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile,
      TEMP: temporary, TMP: temporary, TMPDIR: temporary,
      ...gitEnvironment,
      ...(gitSh ? { PATH: `${dirname(gitSh.path)}${delimiter}${process.env.PATH ?? ''}` } : {}),
    }),
  });
  let result, failed;
  try {
    const close = await waitForStdioChildClose(child, 180000, 'owned project knowledge worker');
    result = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(close.code, 0, result.error ?? 'inspect owned project knowledge worker log');
    assert.equal(result.stage, 'passed'); assert.equal(result.nativeExit.code, 0);
    assert.deepEqual(result.gitEnvironment, gitEnvironment, 'the actual worker must inherit the same isolated Git inputs');
    assert.equal(new Set(result.threads).size, 2);
    assert.equal(result.turns.length, 6);
    assert.deepEqual(result.turns.map(turn => turn.marker), MARKERS);
    assert.deepEqual(result.approvals.map(approval => approval.decision), ['decline', 'accept', 'accept']);
    assert.deepEqual(scenario.evidence.failures, []);
    assert.equal(scenario.evidence.requests, model.requests.length);
    assert.equal(model.requests.length, 46, 'the six explicit turns include every required Native read before write and must not replay requests');
    assert.ok(scenario.evidence.nextTask?.source?.revision);
    assert.deepEqual(await readFile(settingsPath), settingsBefore, 'Native must preserve fixture settings');
  } catch (error) { failed = error; }
  finally {
    if (!result) result = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null);
    await context.writeArtifactJson('knowledge-native-result.json', { worker: result, provider: scenario.evidence, modelRequestCount: model.requests.length,
      ...(failed ? { failure: failed.stack ?? failed.message } : {}) });
  }
  if (failed) throw failed;
});
