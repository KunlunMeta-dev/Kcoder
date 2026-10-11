import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  manualLiveSuites,
  modelIndependentSuites,
  realModelSuites,
  registeredSuites,
  smokeSuites,
} from "../suite-registry.mjs";

const e2eRoot = resolve(import.meta.dirname, "..");

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

  for (const suite of registeredSuites) {
    const source = await readFile(resolve(e2eRoot, suite), "utf8");
    const tier = source.match(/tier:\s*["']([^"']+)["']/)?.[1];
    const modelPolicy = source.match(/modelPolicy:\s*["']([^"']+)["']/)?.[1];
    assert.ok(tier, `${suite} 缺少静态 tier metadata`);
    assert.ok(modelPolicy, `${suite} 缺少静态 modelPolicy metadata`);

    const expectedBucket = tier === "manual-live"
      ? manualLiveSuites
      : modelPolicy === "real-model-required" || tier.includes("credentialed")
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
