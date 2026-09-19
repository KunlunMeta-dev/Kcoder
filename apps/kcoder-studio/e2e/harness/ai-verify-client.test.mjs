import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunContext } from './run-context.mjs';
import { assertOwnedControllerRequest, startOwnedAiVerify } from './ai-verify-client.mjs';

test('a stopped or signaled controller cannot receive credentials, including shutdown requests', () => {
  const live = { exitCode: null, signalCode: null };
  assert.doesNotThrow(() => assertOwnedControllerRequest(live, false, '/command'));
  assert.doesNotThrow(() => assertOwnedControllerRequest(live, true, '/shutdown'));
  assert.throws(() => assertOwnedControllerRequest(live, true, '/command'), /closed|stopping/);
  assert.throws(() => assertOwnedControllerRequest(live, true, '/status'), /closed|stopping/);
  for (const child of [
    { exitCode: 0, signalCode: null },
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' },
    { exitCode: null, signalCode: 'SIGKILL' },
  ]) for (const path of ['/command', '/status', '/shutdown']) {
    assert.throws(() => assertOwnedControllerRequest(child, false, path), /closed/);
    assert.throws(() => assertOwnedControllerRequest(child, true, path), /closed/);
  }
});

test('failed native process startup is cleaned before the suite returns (no UI/runtime claim)', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-tauri-startup-failure' });
  const rendererRoot = context.pathInState('failure-renderer');
  await mkdir(rendererRoot);
  await writeFile(resolve(rendererRoot, 'index.html'), '<!doctype html><html><head><title>Startup failure fixture</title></head><body></body></html>');
  await assert.rejects(startOwnedAiVerify(context, {
    tauriBin: '/usr/bin/false', kcoderBin: '/usr/bin/false', rendererRoot, timeoutMs: 10_000,
  }), /Tauri|Verification|WebView/);
  await context.finish('passed', { expectedNativeStartupFailure: true });
  const { runRoot } = JSON.parse(await readFile(resolve(context.artifactsDir, 'tauri-run.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(runRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.ok(manifest.processes.some(process => process.label === 'tauri-app' && process.command === 'false'));
  assert.ok(manifest.cleanupSteps.every(step => step.status === 'completed'));
  await assert.rejects(access(resolve(runRoot, 'state')));
});
