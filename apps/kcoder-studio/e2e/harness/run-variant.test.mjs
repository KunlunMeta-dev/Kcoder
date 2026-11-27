import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import { runVariantId } from "./run-variant.mjs";

test("variant identifiers are explicit, stable, and portable directory names", () => {
  assert.equal(runVariantId(), "default");
  for (const value of ["default", "win32-slow", "scenario_2", "a".repeat(64)]) assert.equal(runVariantId(value), value);
  for (const value of [null, 1, {}, "", "../escape", "/absolute", "a/b", "A", "a.", "con", "nul.txt", "com1", "a".repeat(65)]) {
    assert.throws(() => runVariantId(value), /variantId/);
  }
});

test("real allocation, parallel lifecycle, receipts and handoff retain the correct variant", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-run-variant-"));
  const context = new RunContext(fileURLToPath(import.meta.url), "harness/run-variant.test.mjs", root, {});
  t.after(async () => {
    try { await context.finish("passed", { unitTest: true }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await context.initialize();
  // Route sweeps to this worker's variant directories, never the shared E2E tree.
  const script = `import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { access, readFile, writeFile, rename, rm } from 'node:fs/promises';
    import { basename, dirname, resolve } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { fileURLToPath } from 'node:url';
    const { enforceRetention } = await import(${JSON.stringify(new URL("./retention.mjs", import.meta.url).href)});
    const scopes = new Set(), roots = new Set(), contexts = [];
    let failNextSweep = false;
    mock.module(${JSON.stringify(new URL("./retention.mjs", import.meta.url).href)}, { namedExports: {
      enforceRetention: async () => {
        if (failNextSweep) { failNextSweep = false; throw new Error('owned-retention-private-value'); }
        for (const scope of scopes) await enforceRetention(scope); return [];
      }
    }});
    const { RunContext, runE2E, retainedArtifactRunRoot, waitFor } = await import(${JSON.stringify(new URL("./run-context.mjs", import.meta.url).href)});
    const { suiteFailedFromNetworkChange } = await import(${JSON.stringify(new URL("../run-all.mjs", import.meta.url).href)});
    const source = ${JSON.stringify(import.meta.url)}, sourcePath = fileURLToPath(source);
    const original = RunContext.prototype.initialize;
    RunContext.prototype.initialize = async function () {
      roots.add(this.runRoot); scopes.add(dirname(this.runRoot)); return original.call(this);
    };
    const record = value => { contexts.push(value); return value; };
    const json = async path => JSON.parse(await readFile(path, 'utf8'));
    try {
      let first, second, releaseFirst, releaseSecond;
      const a = runE2E(source, { variantId: 'busy' }, async value => {
        first = record(value); await new Promise(resolve => { releaseFirst = resolve; });
      });
      const b = runE2E(source, { variantId: 'busy' }, async value => {
        second = record(value); await new Promise(resolve => { releaseSecond = resolve; });
      });
      await waitFor(() => releaseFirst && releaseSecond, 3000, 'both same-variant runs entered without a lock');
      assert.notEqual(first.runRoot, second.runRoot);
      assert.equal(dirname(first.runRoot), dirname(second.runRoot));
      assert.equal(basename(dirname(first.runRoot)), 'busy');
      await access(first.stateDir); await access(second.stateDir);
      releaseFirst(); await a;
      await access(first.runRoot); await access(second.stateDir);
      let quiet;
      await runE2E(source, { variantId: 'quiet' }, async value => { quiet = record(value); });
      releaseSecond(); await b;
      await assert.rejects(access(first.runRoot), { code: 'ENOENT' });
      await access(quiet.runRoot); await access(second.runRoot);
      assert.equal((await json(resolve(second.runRoot, 'manifest.json'))).variantId, 'busy');
      assert.equal(retainedArtifactRunRoot(sourcePath, basename(second.runRoot), 'busy'), second.runRoot);

      const damaged = record(await RunContext.create(source, { variantId: 'busy' }));
      damaged.writeArtifactJsonInternal = async () => { throw new Error('owned receipt write fault'); };
      await assert.rejects(damaged.finish('passed', {}), /owned receipt write fault/);
      await access(second.runRoot); // A missing new result never replaces the previous complete pair.

      const held = record(await RunContext.create(source, { variantId: 'quiet' }));
      held.addCleanup('unconfirmed owner', () => { throw new Error('owned cleanup fault'); });
      await assert.rejects(held.finish('passed', {}), /owned cleanup fault/);
      await access(held.stateDir); await access(quiet.runRoot);

      process.env.KCODER_E2E_VARIANT_ID = 'from-environment';
      const fromEnv = record(await RunContext.create(source));
      assert.equal(fromEnv.variantId, 'from-environment'); await fromEnv.finish('passed', {});
      const explicit = record(await RunContext.create(source, { variantId: 'explicit' }));
      assert.equal(explicit.variantId, 'explicit'); await explicit.finish('passed', {});
      delete process.env.KCODER_E2E_VARIANT_ID;
      await assert.rejects(RunContext.create(source, { variantId: '../escape' }), /variantId/);
      await assert.rejects(RunContext.create(source, { variantId: null }), /variantId/);

      let warningRun, warning = '';
      const originalWarn = console.warn;
      console.warn = value => { warning += value; };
      try {
        await runE2E(source, { variantId: 'cleanup-warning' }, async value => {
          warningRun = record(value); value.registerSecret('owned-retention-private-value'); failNextSweep = true;
        });
      } finally { console.warn = originalWarn; }
      assert.match(warning, /evidence cleanup failed/); assert.match(warning, /REDACTED/);
      assert.ok(!warning.includes('owned-retention-private-value'));
      assert.equal((await json(resolve(warningRun.runRoot, 'manifest.json'))).status, 'passed');
      assert.equal((await json(resolve(warningRun.runRoot, 'artifacts/result.json'))).status, 'passed');
      await runE2E(source, { variantId: 'cleanup-warning' }, async value => { record(value); });
      await assert.rejects(access(warningRun.runRoot), { code: 'ENOENT' });

      const legacy = record(await RunContext.create(source));
      await legacy.finish('passed', {});
      const legacyPath = resolve(dirname(dirname(legacy.runRoot)), basename(legacy.runRoot));
      await rename(legacy.runRoot, legacyPath); roots.add(legacyPath);
      const manifest = await json(resolve(legacyPath, 'manifest.json')); delete manifest.variantId;
      await writeFile(resolve(legacyPath, 'manifest.json'), JSON.stringify(manifest));
      assert.equal(retainedArtifactRunRoot(sourcePath, basename(legacyPath)), legacyPath);
      assert.notEqual(retainedArtifactRunRoot(sourcePath, basename(legacyPath), 'quiet'), legacyPath);

      await second.writeArtifactJsonInternal('network-error.json', { error: 'ERR_NETWORK_CHANGED' });
      assert.equal(await suiteFailedFromNetworkChange('harness/run-variant.test.mjs', 0, 'quiet'), false);
      assert.equal(await suiteFailedFromNetworkChange('harness/run-variant.test.mjs', 0, 'busy'), true);

      const { resumeGatewayVerificationRun } = await import(${JSON.stringify(new URL("./ai-verify-gateway.mjs", import.meta.url).href)});
      const handoffSource = ${JSON.stringify(new URL("./ai-verify-gateway.mjs", import.meta.url).href)};
      const handoff = record(await RunContext.create(handoffSource, { variantId: 'owned-variant-handoff' }));
      const resumed = record(await resumeGatewayVerificationRun(handoff.runRoot, 'owned-synthetic-handoff-value-12345'));
      assert.equal(resumed.variantId, 'owned-variant-handoff');
      await resumed.finish('passed', {}); handoff.finished = true;
      process.stdout.write('VARIANT_LIFECYCLE_VERIFIED\\n');
    } finally {
      for (const item of contexts) if (!item.finished) await item.finish('failed', {}).catch(() => {});
      for (const path of roots) await rm(path, { recursive: true, force: true });
    }`;
  const child = context.spawnOwned("variant-lifecycle-integration", process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], {
    env: context.isolatedEnvironment(),
  });
  let output = "", diagnostics = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-3000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Variant integration exceeded 15 seconds")), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Variant integration exited ${code}: ${context.redactText(diagnostics)}`)); });
  });
  assert.match(output, /VARIANT_LIFECYCLE_VERIFIED/);
});
