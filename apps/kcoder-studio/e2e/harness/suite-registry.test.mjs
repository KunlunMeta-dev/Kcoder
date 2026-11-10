import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { selectSuites } from './runner-options.mjs';
import {
  manualLiveSuites,
  modelIndependentSuites,
  realModelSuites,
  registeredSuites,
  smokeSuites,
} from "../suite-registry.mjs";

const manualLiveMobileBoundarySuites = [
  "suites/mobile/mobile-high-latency-public-no-reload-setup.e2e.mjs",
  "suites/mobile/mobile-rnw-inverted-touch-history.e2e.mjs",
  "suites/mobile/mobile-workspace-profile-fence-web-multitab.review.e2e.mjs",
  "suites/mobile/mobile-workspace-task-handoff-browser.observed.review.e2e.mjs",
  "suites/mobile/mobile-workspace-task-handoff-browser.review.e2e.mjs",
  "suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs",
];

const e2eRoot = resolve(import.meta.dirname, "..");

test('cancelled real-task evaluation has no executable or batch registration while other models remain selectable', async () => {
  const cancelled = 'suites/model/real-model-web-search-quality.e2e.mjs';
  assert.equal(registeredSuites.includes(cancelled), false);
  assert.equal(selectSuites(realModelSuites, ['--real-model'], { KCODER_E2E_REAL_MODEL: '1' }).includes(cancelled), false);
  assert.throws(() => selectSuites(registeredSuites, ['--real-model', '--suite', cancelled], { KCODER_E2E_REAL_MODEL: '1' }), /uniquely select/);
  await assert.rejects(readFile(resolve(e2eRoot, cancelled)), { code: 'ENOENT' });
  const matrix = await readFile(resolve(e2eRoot, '../../../tests/matrix.toml'), 'utf8');
  assert.equal(matrix.includes('id = "web-search-real-model-quality"'), false);
  assert.ok(realModelSuites.includes('suites/model/real-model-task.e2e.mjs'));
  assert.ok(modelIndependentSuites.includes('suites/browser/web-search-positive-native.e2e.mjs'));
});

test("每个 E2E suite 都必须显式登记且只能登记一次", async () => {
  const files = (await collectSuites(resolve(e2eRoot, "suites")))
    .map(file => file.slice(e2eRoot.length + 1))
    .sort();
  assert.deepEqual([...registeredSuites].sort(), files);
  assert.equal(new Set(registeredSuites).size, registeredSuites.length);
});

test("自动矩阵不得混入 manual-live 或真实模型 suite", async () => {
  assert.ok(smokeSuites.every(suite => modelIndependentSuites.includes(suite)));
  assert.equal(modelIndependentSuites.some(suite => manualLiveSuites.includes(suite)), false);
  assert.equal(modelIndependentSuites.some(suite => realModelSuites.includes(suite)), false);
  assert.ok(manualLiveMobileBoundarySuites.every(suite =>
    manualLiveSuites.includes(suite) && !modelIndependentSuites.includes(suite)),
  "public, privately pinned, and review Mobile diagnostics must remain outside the automatic matrix");
  assert.ok(modelIndependentSuites.includes("suites/mobile/mobile-session-cache-recovery.e2e.mjs"),
    "session transcript cache recovery must be in the model-independent full-integration matrix");
  assert.ok(modelIndependentSuites.includes("suites/gateway/project-knowledge-publication.e2e.mjs"),
    "the real Native project knowledge flow uses a deterministic local provider, never paid-model consent");
  for (const suite of [
    "suites/mobile/mobile-session-cache-event-continuity.e2e.mjs",
    "suites/mobile/mobile-session-cache-multirealm.e2e.mjs",
    "suites/mobile/mobile-session-cache-unknown-offline-v1.e2e.mjs",
    "suites/mobile/mobile-session-cache-workspace-absence.e2e.mjs",
    "suites/mobile/mobile-session-cache-permission-revocation.e2e.mjs",
  ]) {
    assert.ok(modelIndependentSuites.includes(suite),
      `${suite} must be in the model-independent full-integration matrix`);
  }

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
        const suiteStart = source.indexOf("await runE2E", bindingStart);
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
    else if (entry.name.endsWith(".e2e.mjs")) found.push(path);
  }
  return found;
}
