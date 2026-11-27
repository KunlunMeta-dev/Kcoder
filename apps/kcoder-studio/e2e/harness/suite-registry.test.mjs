import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";
import { selectSuites } from './runner-options.mjs';
import {
  manualLiveSuites,
  modelIndependentSuites,
  realModelSuites,
  registeredSuites,
  smokeSuites,
} from "../suite-registry.mjs";


const e2eRoot = resolve(import.meta.dirname, "..");

test('Linux cross-filesystem Config acceptance runs only the explicitly pinned libtest', async () => {
  const suite = '../integration/storage-cross-filesystem.integration.mjs';
  assert.ok(manualLiveSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false);
  assert.equal(realModelSuites.includes(suite), false);
  assert.deepEqual(selectSuites(manualLiveSuites, ['--kind', 'integration', '--suite', 'storage-cross-filesystem'], {}), [suite]);
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  for (const name of ['KCODER_E2E_CONFIG_LIBTEST', 'KCODER_E2E_CONFIG_LIBTEST_SHA256', 'KCODER_E2E_STORAGE_CROSS_VOLUME']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts([suite], { environment: {}, run: async () => assert.fail('Config libtest acceptance must not build CLI, renderer or addon') });
});

test('actual Legacy shared userData startup remains manual-live and preserves both runtime pins', async () => {
  const suite = 'suites/browser/desktop-storage-legacy-startup.e2e.mjs';
  assert.ok(manualLiveSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false);
  assert.equal(realModelSuites.includes(suite), false);
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  for (const name of ['KCODER_E2E_KCODER_BIN', 'KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_STORAGE_ADDON_SHA256'])
    assert.ok(suiteEnvironmentNames(suite).includes(name));
  assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes('KCODER_E2E_STORAGE_ADDON_SHA256'), false);
});

test('storage handoff and relocation retain their runtime pins and explicit cleanup variant', async () => {
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  const relocation = 'suites/browser/desktop-storage-relocation.e2e.mjs';
  const firstLaunch = 'suites/browser/desktop-storage-first-launch.e2e.mjs';
  for (const suite of [relocation, firstLaunch, '../integration/storage-handoff-native-boundaries.integration.mjs']) {
    assert.ok(manualLiveSuites.includes(suite));
    for (const name of ['KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_STORAGE_ADDON_SHA256'])
      assert.ok(suiteEnvironmentNames(suite).includes(name));
  }
  assert.ok(suiteEnvironmentNames(firstLaunch).includes('KCODER_E2E_STORAGE_FIRST_CHOICE'));
  for (const name of ['KCODER_E2E_STORAGE_CROSS_VOLUME', 'KCODER_TARGET_DIR']) {
    assert.ok(suiteEnvironmentNames('../integration/storage-handoff-native-boundaries.integration.mjs').includes(name));
    assert.ok(suiteEnvironmentNames(relocation).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  assert.equal(suiteEnvironmentNames(relocation).includes('KCODER_E2E_STORAGE_FIRST_CHOICE'), false);
  for (const name of ['KCODER_E2E_STORAGE_CLEANUP', 'KCODER_E2E_STORAGE_RENDERER_MODE', 'KCODER_E2E_RENDERER_ROOT']) {
    assert.ok(suiteEnvironmentNames(relocation).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
});

test('pinned storage acceptance and the dialog-only fixture never rebuild unrelated shared products', async () => {
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  for (const [source, environment] of [
    ['suites/browser/desktop-storage-legacy-startup.e2e.mjs', { KCODER_E2E_KCODER_BIN: '/owned/native' }],
    ['suites/browser/desktop-storage-first-launch.e2e.mjs', { KCODER_E2E_KCODER_BIN: '/owned/native' }],
    ['../integration/storage-handoff-native-boundaries.integration.mjs', { KCODER_E2E_KCODER_BIN: '/owned/native' }],
    ['suites/browser/desktop-storage-relocation.e2e.mjs', { KCODER_E2E_KCODER_BIN: '/owned/native', KCODER_E2E_STORAGE_RENDERER_MODE: 'vite' }],
    ['suites/browser/desktop-storage-relocation.e2e.mjs', { KCODER_E2E_KCODER_BIN: '/owned/native', KCODER_E2E_RENDERER_ROOT: '/owned/renderer' }],
    ['../integration/storage-installation-dialog.integration.mjs', {}],
    ['../integration/storage-account-paths.integration.mjs', {}],
  ]) await prepareSuiteArtifacts([source], { environment, run: async () => assert.fail('Explicit storage inputs must not rebuild shared products') });
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  const names = suiteEnvironmentNames('../integration/storage-account-paths.integration.mjs');
  for (const name of ['KCODER_E2E_ELECTRON_BIN', 'KCODER_E2E_ELECTRON_BIN_SHA256']) assert.ok(names.includes(name));
});

test('desktop request-cost selects real renderer integration and retains explicit input pins', async () => {
  const source = 'suites/browser/desktop-request-cost.e2e.mjs';
  assert.deepEqual(selectSuites(modelIndependentSuites, ['--model-independent', '--suite', 'desktop-request-cost'], {}), [source]);
  assert.equal(smokeSuites.includes(source), false);
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  for (const name of ['KCODER_E2E_KCODER_BIN_SHA256', 'KCODER_E2E_RENDERER_ROOT']) assert.ok(suiteEnvironmentNames(source).includes(name));
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  await prepareSuiteArtifacts([source], { environment: { KCODER_E2E_KCODER_BIN: '/owned/native', KCODER_E2E_RENDERER_ROOT: '/owned/renderer' },
    run: async () => assert.fail('Explicit inputs must not rebuild shared products') });
});

test('authentication read-cost integration uses Native without unnecessary renderer builds', async () => {
  const source = '../integration/gateway/browser-session-read-cost.integration.mjs';
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  assert.ok(suiteEnvironmentNames(source).includes('KCODER_E2E_KCODER_BIN_SHA256'));
  assert.deepEqual(selectSuites(modelIndependentSuites, ['--model-independent', '--suite', 'browser-session-read-cost'], {}), [source]);
  assert.equal(smokeSuites.includes(source), false);
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  const commands = [];
  const run = async (command, args) => commands.push([command, ...args]);
  await prepareSuiteArtifacts([source], { run, environment: {} });
  assert.deepEqual(commands, [['cargo', 'build', '-p', 'kcoder_cli', '--bin', 'kcoder']]);
  commands.length = 0;
  await prepareSuiteArtifacts([source], { run, environment: { KCODER_E2E_KCODER_BIN: '/owned/pinned/kcoder' } });
  assert.deepEqual(commands, []);
  const matrix = await readFile(resolve(e2eRoot, '../../../tests/matrix.toml'), 'utf8');
  const entries = matrix.split('[[suite]]').filter(entry => entry.includes('id = "studio-browser-session-read-cost"'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^tiers = \["full"\]$/m);
  assert.match(entries[0], /^platforms = \["linux"\]$/m);
  assert.match(entries[0], /"build-debug-cli"/);
});

test('cancelled real-task evaluation has no executable or batch registration while other models remain selectable', async () => {
  const cancelled = 'suites/model/real-model-web-search-quality.e2e.mjs';
  assert.equal(registeredSuites.includes(cancelled), false);
  assert.equal(selectSuites(realModelSuites, ['--real-model'], { KCODER_E2E_REAL_MODEL: '1' }).includes(cancelled), false);
  assert.throws(() => selectSuites(registeredSuites, ['--real-model', '--suite', cancelled], { KCODER_E2E_REAL_MODEL: '1' }), /uniquely select/);
  await assert.rejects(readFile(resolve(e2eRoot, cancelled)), { code: 'ENOENT' });
  const matrix = await readFile(resolve(e2eRoot, '../../../tests/matrix.toml'), 'utf8');
  assert.equal(matrix.includes('id = "web-search-real-model-quality"'), false);
  assert.ok(realModelSuites.includes('../integration/model/real-model-task.integration.mjs'));
  assert.ok(modelIndependentSuites.includes('suites/browser/web-search-positive-native.e2e.mjs'));
});

test('retired ordinary Office suites cannot be selected while business and reader regressions remain', async () => {
  for (const source of [
    'suites/office/office-native-download.e2e.mjs',
    'suites/office/office-request-only-native.e2e.mjs',
    'suites/office/task-artifacts-native-download.e2e.mjs',
    'suites/browser/automation-native-office-claim.e2e.mjs',
  ]) {
    assert.equal(registeredSuites.includes(source), false);
    assert.throws(() => selectSuites(registeredSuites, ['--suite', source]), /uniquely select/);
    await assert.rejects(readFile(resolve(e2eRoot, source)), { code: 'ENOENT' });
  }
  for (const source of [
    '../integration/gateway/remote-material-upload-native.integration.mjs',
    'suites/browser/automation-period-budget.e2e.mjs',
    '../integration/office/office-read-worker.integration.mjs',
    '../integration/office/office-reader-acceptance.integration.mjs',
    '../integration/model/real-model-kworker-office.integration.mjs',
  ]) assert.ok(registeredSuites.includes(source));
});

test("manual model stream browser regression has one offline full matrix entry", async () => {
  const id = "manual-model-stream-reconnect";
  const source = `suites/browser/${id}.e2e.mjs`;
  assert.deepEqual(selectSuites(modelIndependentSuites, ["--model-independent", "--suite", id], {}), [source]);
  for (const suites of [smokeSuites, manualLiveSuites, realModelSuites]) {
    assert.equal(suites.includes(source), false);
  }
  const matrix = await readFile(resolve(e2eRoot, "../../../tests/matrix.toml"), "utf8");
  const entries = matrix.split("[[suite]]").filter(entry => entry.includes(`"${id}"`));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^tiers = \["full"\]$/m);
  assert.match(entries[0], /"--model-independent", "--suite", "manual-model-stream-reconnect"/);
});

test("direct model stream stdio prepares both binaries without building the renderer", async () => {
  const { prepareSuiteArtifacts } = await import("../run-all.mjs");
  const commands = [];
  await prepareSuiteArtifacts(["../integration/gateway/model-stream-stdio.integration.mjs"], {
    run: async (command, args) => commands.push([command, ...args]),
  });
  assert.deepEqual(commands, [
    ["cargo", "build", "-p", "kcoder_cli", "--bin", "kcoder"],
    ["cargo", "build", "--locked", "-p", "kcoder_cli", "--bin", "kcoder-e2e-stdio-driver", "--features", "e2e-http-transport"],
  ]);
});

test("每个 E2E 或集成测试都必须显式登记且只能登记一次", async () => {
  const files = [...await collectSuites(resolve(e2eRoot, "suites")), ...await collectSuites(resolve(e2eRoot, "../integration"))]
    .map(file => relative(e2eRoot, file))
    .sort();
  assert.deepEqual([...registeredSuites].sort(), files);
  assert.equal(new Set(registeredSuites).size, registeredSuites.length);
});

test("自动矩阵不得混入 manual-live 或真实模型 suite", async () => {
  assert.ok(smokeSuites.every(suite => modelIndependentSuites.includes(suite)));
  assert.equal(modelIndependentSuites.some(suite => manualLiveSuites.includes(suite)), false);
  assert.equal(modelIndependentSuites.some(suite => realModelSuites.includes(suite)), false);
  assert.ok(modelIndependentSuites.includes("../integration/gateway/project-knowledge-publication.integration.mjs"),
    "the real Native project knowledge flow uses a deterministic local provider, never paid-model consent");


  for (const suite of registeredSuites) {
    const source = await readFile(resolve(e2eRoot, suite), "utf8");
    const tier = source.match(/tier:\s*["']([^"']+)["']/)?.[1];
    const modelPolicyExpression = source.match(
      /modelPolicy:\s*([\s\S]*?)(?=,\s*[A-Za-z_$][\w$]*\s*:|\s*}\s*(?:,|\)|$))/,
    )?.[1];
    let modelPolicySource = modelPolicyExpression ?? "";
    const modelPolicyIdentifier = modelPolicySource.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (modelPolicyIdentifier) {
      const bindingStart = source.indexOf(`const ${modelPolicyIdentifier} =`);
      if (bindingStart >= 0) {
        const suiteStart = source.indexOf("await run", bindingStart);
        modelPolicySource = source.slice(bindingStart, suiteStart < 0 ? undefined : suiteStart);
      }
    }
    const modelPolicies = [...modelPolicySource.matchAll(/(["'`])([\s\S]*?)\1/gs)]
      .map(match => match[2]);
    assert.ok(tier, `${suite} 缺少静态 tier metadata`);
    assert.ok(modelPolicies.length > 0, `${suite} 缺少静态 modelPolicy metadata`);

    const expectedBucket = tier === "manual-live"
      ? manualLiveSuites
      : modelPolicies.includes("real-model-required") || tier.includes("credentialed")
        ? realModelSuites
        : modelIndependentSuites;
    assert.ok(expectedBucket.includes(suite), `${suite} 的 tier/modelPolicy 与 registry 分类不一致`);
  }
});

async function collectSuites(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectSuites(path));
    else if (/\.(e2e|integration)\.mjs$/.test(entry.name)) found.push(path);
  }
  return found;
}
